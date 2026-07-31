/**
 * Projects carry Today/Evening state exactly like to-dos (probe O12): the wire
 * emits `when` on project rows on every surface, and the TTY places the ★/⏾ pip
 * (including `renderProjectsSidebar`). Plus the R12 single-source rule — every
 * TTY when/Today/Evening state consumes the derived `when`, never `startBucket`/
 * `todaySection` (a stale-bytes row is Today, not Evening) — and the 12-hour TTY
 * reminder chip (the wire keeps 24h `HH:MM`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { resolveInvocation } from "../../src/cli/resolve-invocation.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject } from "../fixtures/seed.ts";

let fx: FixtureDb;
let stateDir: string;
let stdout: string[];
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  fx = buildFixtureDb();
  stateDir = mkdtempSync(join(tmpdir(), "things-api-pips-test-"));
  for (const key of [
    "THINGS_DB",
    "THINGS_API_STATE_DIR",
    "THINGS_API_CONFIG_DIR",
    "THINGS_NOW",
    "THINGS_TZ",
  ]) {
    envBackup[key] = process.env[key];
  }
  process.env["THINGS_DB"] = fx.path;
  process.env["THINGS_API_STATE_DIR"] = stateDir;
  process.env["THINGS_API_CONFIG_DIR"] = join(stateDir, "config");
  process.env["THINGS_NOW"] = "2026-07-31T12:00:00";
  process.env["THINGS_TZ"] = "UTC";
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
  fx.close();
  rmSync(stateDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

function runCli(argv: string[]): string {
  stdout.length = 0;
  process.exitCode = undefined;
  const program = buildProgram();
  program.exitOverride();
  try {
    program.parse(resolveInvocation(program, [...argv, "--db", fx.path]).argv, { from: "user" });
  } catch {
    /* usage errors set exitCode */
  }
  return stdout.join("");
}

/** Strip ANSI SGR so assertions match the visible glyphs/text. */
const plain = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

function seedWorld(): { area: string; today: string; evening: string; stale: string } {
  const area = seedArea(fx.db, "Work", 0);
  const today = seedProject(fx.db, {
    title: "proj-today",
    area,
    start: "active",
    startDate: "2026-07-31",
  });
  const evening = seedProject(fx.db, {
    title: "proj-evening",
    area,
    start: "active",
    startDate: "2026-07-31",
    evening: true,
  });
  // STALE bytes: startBucket=1 (evening) but the startDate is in the PAST — the
  // evening marker expires daily, so this row is Today, not This Evening.
  const stale = seedProject(fx.db, {
    title: "proj-stale",
    area,
    start: "active",
    startDate: "2026-07-01",
    evening: true,
    reminder: "18:00",
  });
  seedProject(fx.db, { title: "proj-anytime", area });
  return { area, today, evening, stale };
}

describe("wire: project rows emit `when` like to-dos", () => {
  it("projects list emits when today/evening/absent per project", () => {
    seedWorld();
    const env = JSON.parse(runCli(["projects", "--json"]));
    const byTitle = new Map(
      (env.data.items as Array<{ title: string; when?: string }>).map((p) => [p.title, p.when]),
    );
    expect(byTitle.get("proj-today")).toBe("today");
    expect(byTitle.get("proj-evening")).toBe("evening");
    // Stale evening bytes resolve to today (the evening marker expired) — NOT evening.
    expect(byTitle.get("proj-stale")).toBe("today");
    expect(byTitle.get("proj-anytime")).toBeUndefined();
  });

  it("area-view project section emits when on project rows", () => {
    const { area } = seedWorld();
    const env = JSON.parse(runCli(["area", "show", area, "--json"]));
    const byTitle = new Map(
      (env.data.view.projects as Array<{ title: string; when?: string }>).map((p) => [
        p.title,
        p.when,
      ]),
    );
    expect(byTitle.get("proj-today")).toBe("today");
    expect(byTitle.get("proj-evening")).toBe("evening");
    expect(byTitle.get("proj-stale")).toBe("today");
  });

  it("the wire reminder stays 24-hour HH:MM (machine format unchanged)", () => {
    seedWorld();
    const env = JSON.parse(runCli(["projects", "--json", "--full"]));
    const stale = (env.data.items as Array<{ title: string; reminder?: string }>).find(
      (p) => p.title === "proj-stale",
    );
    expect(stale?.reminder).toBe("18:00");
  });
});

describe("TTY: project rows carry the ★/⏾ pip", () => {
  it("renderProjectsSidebar pips today/evening projects", () => {
    seedWorld();
    const out = plain(runCli(["projects"]));
    const line = (t: string) => out.split("\n").find((l) => l.includes(t)) ?? "";
    expect(line("proj-today")).toContain("★");
    expect(line("proj-evening")).toContain("⏾");
    // Stale evening bytes → Today ★, never the ⏾.
    expect(line("proj-stale")).toContain("★");
    expect(line("proj-stale")).not.toContain("⏾");
    expect(line("proj-anytime")).not.toMatch(/[★⏾]/u);
  });
});

describe("TTY when/Today/Evening is single-source (consumes the derived `when`)", () => {
  it("a stale evening-bytes project renders `★ Today`, matching the wire when:today", () => {
    const { stale } = seedWorld();
    // Wire agrees:
    const env = JSON.parse(runCli(["show", stale, "--json"]));
    expect(env.data.view.project.when).toBe("today");
    // TTY detail card must NOT re-derive Evening from startBucket.
    const out = plain(runCli(["show", stale]));
    expect(out).toContain("★ Today");
    expect(out).not.toContain("This Evening");
  });

  it("the TTY reminder chip renders 12-hour (h:mmam/pm)", () => {
    const { stale } = seedWorld();
    const out = plain(runCli(["show", stale]));
    expect(out).toContain("6:00pm");
    expect(out).not.toContain("18:00");
  });
});
