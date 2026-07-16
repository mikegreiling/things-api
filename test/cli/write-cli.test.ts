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
import { seedArea, seedProject, seedTag, seedTodo } from "../fixtures/seed.ts";

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

  it("project move --dry-run plans the URL area re-assignment (P23)", async () => {
    const area = seedArea(fixture.db, "Work");
    const proj = seedProject(fixture.db, { title: "Mover" });
    await run(["project", "move", proj, "--area", "Work", "--dry-run", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("mutation-plan");
    const plan = env["data"] as Record<string, unknown>;
    expect(plan["vector"]).toBe("url-scheme");
    expect(String(plan["invocation"])).toContain(`update-project?id=${proj}&area-id=${area}`);
  });

  it("project duplicate --dry-run plans the URL duplicate (E17)", async () => {
    const proj = seedProject(fixture.db, { title: "Copyable" });
    await run(["project", "duplicate", proj, "--dry-run", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("mutation-plan");
    const plan = env["data"] as Record<string, unknown>;
    expect(plan["vector"]).toBe("url-scheme");
    expect(String(plan["invocation"])).toContain("duplicate=true");
  });

  it("todo restore --dry-run plans move-to-Inbox for a trashed to-do (E15)", async () => {
    const uuid = seedTodo(fixture.db, { title: "trashed", trashed: true });
    await run(["todo", "restore", uuid, "--dry-run", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("mutation-plan");
    const plan = env["data"] as Record<string, unknown>;
    expect(String(plan["invocation"])).toContain(`move to do id "${uuid}" to list "Inbox"`);
  });

  it("heading add --dry-run plans the create-heading proxy on the shortcuts vector", async () => {
    const proj = seedProject(fixture.db, { title: "Dest" });
    await run(["heading", "add", "Dest", "Phase 2", "--dry-run", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("mutation-plan");
    const plan = env["data"] as Record<string, unknown>;
    expect(plan["vector"]).toBe("shortcuts");
    expect(String(plan["invocation"])).toContain("things-proxy-create-heading");
    expect(String(plan["invocation"])).toContain(proj);
  });

  it("todo clear-reminder --dry-run plans the set-detail proxy (Reminder Time = '')", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "dated",
      startDate: "2026-07-20",
      reminder: "09:30",
    });
    await run(["todo", "clear-reminder", uuid, "--dry-run", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("mutation-plan");
    const plan = env["data"] as Record<string, unknown>;
    expect(plan["vector"]).toBe("shortcuts");
    expect(String(plan["invocation"])).toContain("things-proxy-set-detail");
    expect(String(plan["invocation"])).toContain("Reminder Time");
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

  it("todo restore on a non-trashed target", async () => {
    const uuid = seedTodo(fixture.db, { title: "live" });
    await run(["todo", "restore", uuid, "--json"]);
    const env = envelope();
    const error = env["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("blocked:H-UNKNOWN-DESTINATION");
    expect(String(error["message"])).toContain("not in the Trash");
    expect(process.exitCode).toBe(4);
  });

  it("heading add into an unknown project is rejected", async () => {
    await run(["heading", "add", "ghost-project", "New Phase", "--json"]);
    const env = envelope();
    expect((env["error"] as Record<string, unknown>)["code"]).toBe("blocked:H-UNKNOWN-DESTINATION");
    expect(process.exitCode).toBe(4);
  });

  it("todo clear-reminder on a to-do with no reminder is rejected", async () => {
    const uuid = seedTodo(fixture.db, { title: "no reminder", startDate: "2026-07-20" });
    await run(["todo", "clear-reminder", uuid, "--json"]);
    const env = envelope();
    expect((env["error"] as Record<string, unknown>)["code"]).toBe("blocked:H-NO-REMINDER");
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

describe("project write targets accept names (Part 1)", () => {
  it("resolves a project by unique name (dry-run compiles with the real uuid)", async () => {
    const proj = seedProject(fixture.db, { title: "Firmware" });
    await run(["project", "update", "Firmware", "--title", "Renamed", "--dry-run", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("mutation-plan");
    expect(String((env["data"] as Record<string, unknown>)["invocation"])).toContain(proj);
  });

  it("dash/case-forgiving name resolution (mirrors the read side)", async () => {
    const proj = seedProject(fixture.db, { title: "Restore Astro City Cabinet" });
    await run([
      "project",
      "update",
      "restore-astro-city-cabinet",
      "--title",
      "X",
      "--dry-run",
      "--json",
    ]);
    const env = envelope();
    expect(String((env["data"] as Record<string, unknown>)["invocation"])).toContain(proj);
  });

  it("a uuid still resolves unchanged", async () => {
    const proj = seedProject(fixture.db, { title: "ByUuid" });
    await run(["project", "update", proj, "--title", "X", "--dry-run", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("mutation-plan");
    expect(String((env["data"] as Record<string, unknown>)["invocation"])).toContain(proj);
  });

  it("an unknown project name is refused, naming the accepted forms", async () => {
    await run(["project", "update", "Ghostproject", "--title", "X", "--json"]);
    const env = envelope();
    expect(env["ok"]).toBe(false);
    expect(String((env["error"] as Record<string, unknown>)["message"])).toContain(
      'no project matching "Ghostproject" — tried uuid, partial-uuid, and name',
    );
  });

  it("a duplicated project name is refused fail-closed, listing candidates with area context", async () => {
    const work = seedArea(fixture.db, "Work");
    const p1 = seedProject(fixture.db, { title: "Dup", area: work });
    const p2 = seedProject(fixture.db, { title: "Dup" });
    await run(["project", "update", "Dup", "--title", "X", "--json"]);
    const env = envelope();
    const message = String((env["error"] as Record<string, unknown>)["message"]);
    expect(message).toContain('"Dup" matches 2 projects');
    expect(message).toContain(p1.slice(0, 8));
    expect(message).toContain(p2.slice(0, 8));
    expect(message).toContain("(in Work)");
  });

  it("to-do write targets stay uuid-only (Part 2 entity noun)", async () => {
    await run(["todo", "update", "Buymilk", "--title", "X", "--json"]);
    const env = envelope();
    expect(String((env["error"] as Record<string, unknown>)["message"])).toContain(
      'no to-do matching uuid or partial-uuid "Buymilk"',
    );
  });

  it("heading write targets stay uuid-only (Part 2 entity noun)", async () => {
    await run(["heading", "rename", "Sometitle", "New Name", "--json"]);
    const env = envelope();
    expect(String((env["error"] as Record<string, unknown>)["message"])).toContain(
      'no heading matching uuid or partial-uuid "Sometitle"',
    );
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

describe("batch (Phase 13)", () => {
  it("streams per-op JSONL, handles bad lines, exits with worst severity", async () => {
    const uuid = seedTodo(fixture.db, { title: "batch-target" });
    const batchFile = join(stateDir, "ops.jsonl");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      batchFile,
      [
        JSON.stringify({ op: "todo.update", params: { uuid, title: "renamed" } }),
        "not json at all {",
        JSON.stringify({ op: "trash.empty", params: {} }),
      ].join("\n"),
    );
    await run(["batch", batchFile, "--dry-run"]);
    const lines = stdout
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4); // 3 results + summary
    expect(lines[0].outcome.kind).toBe("dry-run");
    expect(lines[1].outcome.kind).toBe("invalid");
    expect(lines[1].outcome.detail).toMatch(/not valid JSON/);
    // trash.empty dry-run still hits the H-PERMANENT-DELETE guard first
    expect(lines[2].outcome.kind).toBe("blocked");
    expect(lines[3].summary).toEqual({ total: 3, ok: 1, failed: 2, skipped: 0 });
    expect(process.exitCode).toBe(4); // blocked outranks invalid
  });

  it("--fail-fast skips after the first failure", async () => {
    const uuid = seedTodo(fixture.db, { title: "ff" });
    const batchFile = join(stateDir, "ff.jsonl");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      batchFile,
      [
        JSON.stringify({ op: "trash.empty", params: {} }),
        JSON.stringify({ op: "todo.update", params: { uuid, title: "x" } }),
      ].join("\n"),
    );
    await run(["batch", batchFile, "--dry-run", "--fail-fast"]);
    const lines = stdout
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].outcome.kind).toBe("blocked");
    expect(lines[1].outcome.kind).toBe("skipped");
  });
});

describe("undo selection flags", () => {
  async function seedAudit(records: Record<string, unknown>[]): Promise<void> {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir = join(stateDir, "audit");
    mkdirSync(dir, { recursive: true });
    const base = {
      v: 1,
      ts: "2026-07-05T10:00:00.000Z",
      actor: "mike",
      host: "test-host",
      op: "todo.update",
      uuid: null,
      vector: "url-scheme",
      disruption: 0,
      invocation: "x",
      requested: {},
      pre: null,
      observed: null,
      result: "ok",
      verify: null,
      durationMs: 1,
      env: { pkg: "0.1.0", dbVersion: 26, fingerprint: "ok" },
    };
    writeFileSync(
      join(dir, "2026-07.jsonl"),
      records.map((r) => JSON.stringify({ ...base, ...r })).join("\n"),
    );
  }

  it("--txn and --last are mutually exclusive (usage error, exit 2)", async () => {
    await run(["undo", "--txn", "m-abc", "--last", "2"]);
    expect(process.exitCode).toBe(2);
    expect(stderr.join("")).toContain("--txn cannot be combined with --last or --by");
  });

  it("--txn with an unknown token is a loud usage error", async () => {
    await seedAudit([{ op: "todo.add", uuid: "A", actor: "mike" }]);
    await run(["undo", "--txn", "m-does-not-exist"]);
    expect(process.exitCode).toBe(2);
    expect(stderr.join("")).toContain("no undoable mutation has undo token");
  });

  it("CLI undo defaults to GLOBAL — dry-run picks the newest regardless of author", async () => {
    await seedAudit([
      { ts: "2026-07-05T09:00:00Z", op: "todo.add", uuid: "M1", actor: "mcp" },
      { ts: "2026-07-05T09:30:00Z", op: "todo.add", uuid: "H1", actor: "mike" },
    ]);
    await run(["undo", "--dry-run"]);
    const item = JSON.parse(stdout.join("").trim().split("\n")[0] ?? "{}");
    expect(item.plan.target.uuid).toBe("H1");
    expect(item.plan.target.actor).toBe("mike");
  });

  it("--by mcp narrows to the agent's record even when a human's is newer", async () => {
    await seedAudit([
      { ts: "2026-07-05T09:00:00Z", op: "todo.add", uuid: "M1", actor: "mcp" },
      { ts: "2026-07-05T09:30:00Z", op: "todo.add", uuid: "H1", actor: "mike" },
    ]);
    await run(["undo", "--by", "mcp", "--dry-run"]);
    const item = JSON.parse(stdout.join("").trim().split("\n")[0] ?? "{}");
    expect(item.plan.target.uuid).toBe("M1");
    expect(item.plan.target.actor).toBe("mcp");
  });
});
