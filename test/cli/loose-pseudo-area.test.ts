/**
 * The `loose` pseudo-area: a reserved, case-insensitive ref that addresses the
 * NULL area (area-less items) as an area on READ surfaces only. Covers the
 * composite view content, the router parity (area show / areas / show /
 * projects --area), case-insensitivity, the reserved-word shadow disclosure,
 * and the open/write refusals.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { resolveInvocation } from "../../src/cli/resolve-invocation.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTodo } from "../fixtures/seed.ts";

let fx: FixtureDb;
let stateDir: string;
let stdout: string[];
let stderr: string[];
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  fx = buildFixtureDb();
  stateDir = mkdtempSync(join(tmpdir(), "things-api-loose-test-"));
  for (const key of ["THINGS_DB", "THINGS_API_STATE_DIR", "THINGS_API_CONFIG_DIR"]) {
    envBackup[key] = process.env[key];
  }
  process.env["THINGS_DB"] = fx.path;
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
  fx.close();
  rmSync(stateDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

function runCli(argv: string[]): { stdout: string; stderr: string; exitCode: number } {
  stdout.length = 0;
  stderr.length = 0;
  process.exitCode = undefined;
  const program = buildProgram();
  program.exitOverride();
  try {
    program.parse(resolveInvocation(program, argv).argv, { from: "user" });
  } catch {
    /* exitOverride throws on usage errors; exitCode is already set */
  }
  return {
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    exitCode: Number(process.exitCode ?? 0),
  };
}

async function runCliAsync(argv: string[]): Promise<{ stdout: string; exitCode: number }> {
  stdout.length = 0;
  stderr.length = 0;
  process.exitCode = undefined;
  const program = buildProgram();
  program.exitOverride();
  try {
    await program.parseAsync(["node", "things", ...argv]);
  } catch {
    /* exitOverride throws on usage errors; exitCode is already set */
  }
  return { stdout: stdout.join(""), exitCode: Number(process.exitCode ?? 0) };
}

/**
 * A world with two real areas, an area-less (loose) project, a loose direct
 * to-do, a loose someday to-do, a loose future-scheduled to-do, an INBOX
 * capture (area-less but start=0 — must never surface as loose), and rows that
 * belong to a real area or a project (must never surface as loose).
 */
function seedWorld(): { pLoose: string } {
  const work = seedArea(fx.db, "Work", 0);
  const pWork = seedProject(fx.db, { title: "work-proj", area: work });
  const pLoose = seedProject(fx.db, { title: "loose-proj", index: 5 });
  seedTodo(fx.db, { title: "loose-active", index: 1 });
  seedTodo(fx.db, { title: "loose-someday", start: "someday" });
  seedTodo(fx.db, { title: "loose-later", start: "someday", startDate: "2099-01-01" });
  seedTodo(fx.db, { title: "inbox-capture", start: "inbox" });
  seedTodo(fx.db, { title: "work-loose", area: work });
  seedTodo(fx.db, { title: "work-child", project: pWork });
  seedTodo(fx.db, { title: "loose-child", project: pLoose });
  return { pLoose };
}

describe("area show loose (composite null-area view)", () => {
  it("emits kind area-view with area: null and the loose active content", () => {
    seedWorld();
    const { stdout: out, exitCode } = runCli(["area", "show", "loose", "--json", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const env = JSON.parse(out);
    expect(env.kind).toBe("area-view");
    expect(env.data.view.area).toBeNull();
    // Active section: the area-less project row + the loose active to-do.
    // Inbox capture, real-area rows, and project-nested rows never appear here.
    expect(env.data.view.projects.map((p: { title: string }) => p.title)).toEqual(["loose-proj"]);
    expect(env.data.view.anytime.map((t: { title: string }) => t.title)).toEqual(["loose-active"]);
    const flat = JSON.stringify(env.data);
    expect(flat).not.toContain("inbox-capture");
    expect(flat).not.toContain("work-loose");
    expect(flat).not.toContain("work-child");
  });

  it("--show-later surfaces the loose someday/scheduled to-dos", () => {
    seedWorld();
    const { stdout: out } = runCli([
      "area",
      "show",
      "loose",
      "--show-later",
      "--json",
      "--db",
      fx.path,
    ]);
    const env = JSON.parse(out);
    const later = JSON.stringify([env.data.view.upcoming, env.data.view.someday]);
    expect(later).toContain("loose-someday");
    expect(later).toContain("loose-later");
  });

  it("renders a human card titled Loose with no uri line", () => {
    seedWorld();
    const { stdout: out, exitCode } = runCli(["area", "show", "loose", "--db", fx.path]);
    expect(exitCode).toBe(0);
    expect(out).toContain("Loose");
    expect(out).not.toContain("uri:");
    expect(out).toContain("loose-proj");
    expect(out).toContain("loose-active");
  });

  it("resolves case-insensitively (LOOSE / Loose / loose)", () => {
    seedWorld();
    for (const ref of ["LOOSE", "Loose", "loose"]) {
      const { stdout: out, exitCode } = runCli(["area", "show", ref, "--json", "--db", fx.path]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(out).data.view.area).toBeNull();
    }
  });
});

describe("router parity", () => {
  it("areas loose == area show loose", () => {
    seedWorld();
    const a = JSON.parse(runCli(["areas", "loose", "--json", "--db", fx.path]).stdout);
    const b = JSON.parse(runCli(["area", "show", "loose", "--json", "--db", fx.path]).stdout);
    expect(a.kind).toBe("area-view");
    expect(a.data).toEqual(b.data);
  });

  it("show loose routes to the area-view", () => {
    seedWorld();
    const env = JSON.parse(runCli(["show", "loose", "--json", "--db", fx.path]).stdout);
    expect(env.kind).toBe("area-view");
    expect(env.data.view.area).toBeNull();
  });

  it("bare `things loose` routes to the area-view and echoes the canonical command", () => {
    seedWorld();
    const env = JSON.parse(runCli(["loose", "--json", "--db", fx.path]).stdout);
    expect(env.kind).toBe("area-view");
    expect(env.data.view.area).toBeNull();
    expect(env.meta.resolvedCommand).toBe("things area show loose");
  });

  it("projects --area loose lists only the area-less projects", () => {
    seedWorld();
    const env = JSON.parse(
      runCli(["projects", "--area", "loose", "--json", "--db", fx.path]).stdout,
    );
    const titles = (env.data.items as Array<{ title: string }>).map((p) => p.title);
    expect(titles).toContain("loose-proj");
    expect(titles).not.toContain("work-proj");
  });
});

describe("reserved-word shadowing", () => {
  it("loose wins over a real area named Loose, discloses it, and keeps it uuid-targetable", () => {
    const shadowUuid = seedArea(fx.db, "Loose", 3);
    seedProject(fx.db, { title: "shadow-proj", area: shadowUuid });
    seedTodo(fx.db, { title: "loose-active" });

    const { stdout: out } = runCli(["area", "show", "loose", "--json", "--db", fx.path]);
    const env = JSON.parse(out);
    // The reserved word resolves to the pseudo-area (area null), NOT the real one.
    expect(env.data.view.area).toBeNull();
    expect(JSON.stringify(env.data)).not.toContain("shadow-proj");
    // The disclosure names the shadowing area by uuid, in meta.warnings.
    expect(env.meta.warnings).toEqual([
      expect.stringContaining(`an area named "Loose" exists (uuid ${shadowUuid})`),
    ]);

    // Human output routes the same advisory to stderr.
    const human = runCli(["area", "show", "loose", "--db", fx.path]);
    expect(human.stderr).toContain(`uuid ${shadowUuid}`);

    // The real area stays reachable by uuid — it is a normal area there.
    const real = JSON.parse(runCli(["area", "show", shadowUuid, "--json", "--db", fx.path]).stdout);
    expect(real.data.view.area.title).toBe("Loose");
    expect(JSON.stringify(real.data)).toContain("shadow-proj");
  });

  it("projects --area loose discloses a shadowing area too", () => {
    const shadowUuid = seedArea(fx.db, "loose", 2);
    seedProject(fx.db, { title: "loose-proj" });
    const { stdout: out } = runCli(["projects", "--area", "loose", "--json", "--db", fx.path]);
    expect(JSON.parse(out).meta.warnings).toEqual([expect.stringContaining(`uuid ${shadowUuid}`)]);
  });
});

describe("read-only refusals", () => {
  it("area open loose refuses by name (usage error)", () => {
    seedWorld();
    const { stderr: err, exitCode } = runCli(["area", "open", "loose", "--db", fx.path]);
    expect(exitCode).not.toBe(0);
    expect(err).toContain("derived view");
    expect(err).toContain("cannot be opened");
  });

  it("open loose refuses by name", () => {
    seedWorld();
    const { stderr: err, exitCode } = runCli(["open", "loose", "--db", fx.path]);
    expect(exitCode).not.toBe(0);
    expect(err).toContain("cannot be opened");
  });

  it("todo move --to-area loose refuses (detach is --loose)", async () => {
    const t = seedTodo(fx.db, { title: "detach-me", area: seedArea(fx.db, "Work", 0) });
    const { stdout: out, exitCode } = await runCliAsync([
      "todo",
      "move",
      t,
      "--to-area",
      "loose",
      "--dry-run",
      "--json",
      "--db",
      fx.path,
    ]);
    expect(exitCode).not.toBe(0);
    const env = JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
    expect(env.ok).toBe(false);
    expect(JSON.stringify(env)).toContain("cannot be modified");
  });

  it("project move --to-area loose refuses (detach is --no-area)", async () => {
    const work = seedArea(fx.db, "Work", 0);
    const proj = seedProject(fx.db, { title: "reparent-me", area: work });
    const { stdout: out, exitCode } = await runCliAsync([
      "project",
      "move",
      proj,
      "--to-area",
      "loose",
      "--dry-run",
      "--json",
      "--db",
      fx.path,
    ]);
    expect(exitCode).not.toBe(0);
    const env = JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
    expect(env.ok).toBe(false);
    expect(JSON.stringify(env)).toContain("cannot be modified");
  });
});
