/**
 * The bench sandbox serializes command execution (bench/sandbox.ts). One sandbox
 * is one shell over one fixture DB, so concurrent tool calls — which the agent
 * driver dispatches in parallel when the model emits several in a turn — must
 * still run their `things` children strictly one at a time. Two overlapping
 * checklist edits would otherwise be a lost update: each reads the same
 * pre-state and rewrites the whole list (Things has no item-level surface), so
 * the last writer silently clobbers the other while both report a verified
 * success. Bench-caught (longtail-checklist-edit): a `--check` and an `--add`
 * emitted in one turn dropped one edit ~1/3 of the time.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { buildBenchFixture } from "../../bench/fixture.ts";
import { createSandbox, type Sandbox } from "../../bench/sandbox.ts";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "../../bin/things.js");

function fenceEnv(dbPath: string): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "sandbox-test-"));
  mkdirSync(join(root, "config"));
  mkdirSync(join(root, "state"));
  return {
    THINGS_DB: dbPath,
    THINGS_SIM_WRITES: "1",
    THINGS_NOW: "2026-07-20T09:00:00-05:00",
    THINGS_TZ: "America/Chicago",
    THINGS_API_CONFIG_DIR: join(root, "config"),
    THINGS_API_STATE_DIR: join(root, "state"),
    NO_COLOR: "1",
    PATH: process.env["PATH"] ?? "",
  };
}

function checklist(dbPath: string): { title: string; status: number }[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT c.title, c.status FROM TMChecklistItem c JOIN TMTask t ON c.task = t.uuid
       WHERE t.title = 'Weekly grocery run' ORDER BY c."index"`,
    )
    .all() as { title: string; status: number }[];
  db.close();
  return rows;
}

let sandbox: Sandbox | undefined;

afterEach(() => {
  sandbox = undefined;
});

describe("bench sandbox serialization", () => {
  it("serializes two checklist edits issued in one turn — no lost update", async () => {
    // Fence preflight (the runner asserts this before any task): a bare add
    // must compile to the simulator vector, proving the env is wired.
    const fixture = buildBenchFixture([
      { kind: "area", key: "a", title: "Home base" },
      { kind: "todo", key: "t", title: "Weekly grocery run", container: "a", start: "active" },
      { kind: "checklist-item", key: "c1", title: "Milk", container: "t", index: 0 },
      { kind: "checklist-item", key: "c2", title: "Eggs", container: "t", index: 1 },
      { kind: "checklist-item", key: "c3", title: "Coffee beans", container: "t", index: 2 },
    ]);
    const env = fenceEnv(fixture.path);
    // Confirm the CLI runs under this env at all (skip loudly otherwise).
    const preflight = execFileSync(
      process.execPath,
      [BIN, "search", "Weekly grocery run", "--json"],
      {
        env,
        encoding: "utf8",
      },
    );
    const uuid = (JSON.parse(preflight) as { data: { uuid: string }[] }).data[0]?.uuid;
    expect(uuid).toBeDefined();

    sandbox = createSandbox({ fenceEnv: env, binPath: BIN });

    // Two mutations emitted in a single turn → the driver runs them concurrently.
    const [checkRes, addRes] = await Promise.all([
      sandbox.exec(`things todo checklist ${uuid} --check Eggs`),
      sandbox.exec(`things todo checklist ${uuid} --add "Sparkling water"`),
    ]);
    expect(checkRes.exitCode).toBe(0);
    expect(addRes.exitCode).toBe(0);

    // BOTH edits must survive: Eggs completed, Sparkling appended, nothing dropped.
    const items = checklist(fixture.path);
    expect(items).toHaveLength(4);
    expect(items.find((i) => i.title === "Eggs")?.status).toBe(3);
    expect(items.some((i) => i.title === "Sparkling water" && i.status === 0)).toBe(true);
    // The original items are all still present.
    expect(items.map((i) => i.title).toSorted()).toEqual(
      ["Coffee beans", "Eggs", "Milk", "Sparkling water"].toSorted(),
    );
  });

  it("preserves per-call results and ordering under concurrent dispatch", async () => {
    const fixture = buildBenchFixture([
      { kind: "area", key: "a", title: "Home base" },
      { kind: "todo", key: "t", title: "Weekly grocery run", container: "a", start: "active" },
    ]);
    sandbox = createSandbox({ fenceEnv: fenceEnv(fixture.path), binPath: BIN });
    // Each concurrent call must get its OWN result back, not another call's.
    const [a, b, c] = await Promise.all([
      sandbox.exec("echo alpha"),
      sandbox.exec("echo bravo"),
      sandbox.exec("echo charlie"),
    ]);
    expect(a.stdout.trim()).toBe("alpha");
    expect(b.stdout.trim()).toBe("bravo");
    expect(c.stdout.trim()).toBe("charlie");
  });
});
