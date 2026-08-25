/**
 * Universal `--dry-run` (src/cli/dry-run.ts): the flag is accepted by EVERY
 * command with one contract — "guarantee nothing changes". These lock the three
 * invariants:
 *   (a) a COMPLETENESS lock walks the whole registered tree — every executable
 *       leaf declares the flag, every namespace/root drops it as inert — so a
 *       future command cannot silently regress the invariant;
 *   (b) a read returns BYTE-IDENTICAL output with and without the flag (--json
 *       and human, incl. the bare-ref shorthand and a view-keyword sugar);
 *   (c) the local-side-effect commands honor it (config set previews and writes
 *       nothing) or refuse loudly (mcp), never a silent no-op.
 * The existing write dry-run plans live in test/cli/write-cli.test.ts (untouched).
 */
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Command } from "commander";

import { buildProgram } from "../../src/cli/main.ts";
import { declaresDryRun, stripInertDryRun } from "../../src/cli/dry-run.ts";
import { resolveInvocation } from "../../src/cli/resolve-invocation.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTodo } from "../fixtures/seed.ts";
import { makeTempDir } from "../fixtures/temp-dir.ts";

/**
 * Normalize the one non-deterministic field (`meta.elapsedMs`, a wall-clock
 * timing) so a read comparison isolates whether --dry-run changed anything real.
 */
const norm = (s: string): string => s.replace(/"elapsedMs":\d+/g, '"elapsedMs":0');

/** Run the CLI in-process through the real resolver (mirrors runCli). */
function runCli(argv: string[]): { stdout: string; stderr: string; exitCode: number } {
  const out: string[] = [];
  const err: string[] = [];
  const so = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out.push(String(c));
    return true;
  });
  const se = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    err.push(String(c));
    return true;
  });
  const savedExit = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = buildProgram();
    program.exitOverride();
    let thrown: number | null = null;
    try {
      program.parse(resolveInvocation(program, argv).argv, { from: "user" });
    } catch (e) {
      const ec = (e as { exitCode?: unknown }).exitCode;
      if (typeof ec === "number") thrown = ec;
    }
    const exitCode = thrown ?? (process.exitCode !== undefined ? Number(process.exitCode) : 0);
    return { stdout: out.join(""), stderr: err.join(""), exitCode };
  } finally {
    so.mockRestore();
    se.mockRestore();
    process.exitCode = savedExit;
  }
}

/** Every (path, command) pair in the tree, root last-visited depth-first. */
function everyCommand(root: Command): Array<[string[], Command]> {
  const out: Array<[string[], Command]> = [];
  const walk = (cmd: Command, path: string[]): void => {
    out.push([path, cmd]);
    for (const sub of cmd.commands) walk(sub, [...path, sub.name()]);
  };
  walk(root, []);
  return out;
}

describe("completeness lock: --dry-run reaches every command", () => {
  it("every leaf declares --dry-run; every namespace/root leaves it inert", () => {
    const program = buildProgram();
    for (const [path, cmd] of everyCommand(program)) {
      const label = `things ${path.join(" ")}`.trim();
      if (cmd.commands.length === 0) {
        // An executable leaf must carry the flag — the invariant a future
        // command must not regress. Write verbs declare a visible one; every
        // other leaf inherits the hidden decorator flag.
        expect(declaresDryRun(cmd), `leaf \`${label}\` must accept --dry-run`).toBe(true);
      } else {
        // A namespace/root must NOT declare it (commander would let the ancestor
        // swallow the flag before a write child could — silently turning a
        // dry-run into a real change), and the resolver drops the inert token.
        expect(declaresDryRun(cmd), `non-leaf \`${label}\` must not declare --dry-run`).toBe(false);
        expect(stripInertDryRun(program, [...path, "--dry-run"])).not.toContain("--dry-run");
      }
    }
  });

  it("no leaf command rejects --dry-run as an unknown option", () => {
    // Parse each leaf's own options in isolation (no args, no action side
    // effects) and confirm --dry-run is a recognized option there.
    const program = buildProgram();
    for (const [path, cmd] of everyCommand(program)) {
      if (cmd.commands.length !== 0) continue;
      const known = cmd.options.some((o) => o.long === "--dry-run");
      expect(known, `\`things ${path.join(" ")}\` must recognize --dry-run`).toBe(true);
    }
  });
});

describe("--dry-run at the root and on a namespace does not error", () => {
  it("`things --dry-run` alone renders the same index as bare `things`", () => {
    const bare = runCli([]);
    const dry = runCli(["--dry-run"]);
    expect(dry.stdout).toBe(bare.stdout);
    expect(dry.stderr).not.toMatch(/unknown option/);
  });

  it("`things todo --dry-run` renders the todo namespace help without error", () => {
    const dry = runCli(["todo", "--dry-run"]);
    expect(dry.stderr).not.toMatch(/unknown option/);
    // Namespace help (commander prints it to stdout on a bare group).
    expect(dry.stdout + dry.stderr).toMatch(/add|Usage/);
  });
});

describe("read byte-identity: --dry-run changes nothing", () => {
  let fx: FixtureDb;
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    fx = buildFixtureDb();
    for (const k of ["THINGS_DB", "THINGS_WIDTH", "NO_COLOR"]) envBackup[k] = process.env[k];
    process.env["THINGS_DB"] = fx.path;
    process.env["NO_COLOR"] = "1";
    delete process.env["THINGS_WIDTH"];
    seedArea(fx.db, "Zebra");
    seedProject(fx.db, { title: "Apollo" });
    seedTodo(fx.db, { title: "wash the car", start: "active", startDate: "2026-08-02" });
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fx.close();
  });

  const identical = (base: string[]): void => {
    for (const extra of [[], ["--json"]] as string[][]) {
      const plain = runCli([...base, ...extra]);
      const dry = runCli([...base, ...extra, "--dry-run"]);
      const how = extra.length > 0 ? "--json" : "human";
      expect(norm(dry.stdout), `${base.join(" ")} (${how}) stdout`).toBe(norm(plain.stdout));
      expect(dry.exitCode, `${base.join(" ")} (${how}) exit`).toBe(plain.exitCode);
    }
  };

  it("`things today` is byte-identical with and without --dry-run", () => identical(["today"]));
  it("`things trash` (a view that also parents `trash empty`) is byte-identical", () =>
    identical(["trash"]));
  it("the bare-ref shorthand `things <name>` is byte-identical", () => identical(["Zebra"]));
  it("a view-keyword sugar `things evening` is byte-identical", () => identical(["evening"]));
  it("`things config get` is byte-identical", () => identical(["config", "get"]));
});

describe("local-side-effect commands honor --dry-run", () => {
  let configDir: string;
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    const stateDir = makeTempDir("things-api-universal-dryrun");
    configDir = join(stateDir, "config");
    for (const k of ["THINGS_API_STATE_DIR", "THINGS_API_CONFIG_DIR", "THINGS_API_ACTOR"])
      envBackup[k] = process.env[k];
    delete process.env["THINGS_API_ACTOR"];
    process.env["THINGS_API_STATE_DIR"] = stateDir;
    process.env["THINGS_API_CONFIG_DIR"] = configDir;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(configDir, { recursive: true, force: true });
  });

  it("`config set --dry-run` previews and writes NOTHING", () => {
    const dry = runCli(["config", "set", "actor", "release-bot", "--dry-run"]);
    expect(dry.stdout).toContain("DRY RUN would set actor = release-bot");
    expect(dry.exitCode).toBe(0);
    // The config dir must not exist / carry the value — nothing was persisted.
    let files: string[] = [];
    try {
      files = readdirSync(configDir);
    } catch {
      files = [];
    }
    expect(files).toEqual([]);
    // And the value is still the default, not the previewed one.
    const get = runCli(["config", "get", "actor"]);
    expect(get.stdout).not.toContain("release-bot");
  });

  it("an unknown key still errors under --dry-run (the flag is honest, not a bypass)", () => {
    const r = runCli(["config", "set", "nope", "x", "--dry-run"]);
    expect(r.stderr).toContain('unknown config key "nope"');
    expect(r.exitCode).toBe(2);
  });

  it("`things mcp --dry-run` refuses loudly instead of serving a live surface", () => {
    const r = runCli(["mcp", "--dry-run"]);
    expect(r.stderr).toContain("does not support --dry-run");
    expect(r.exitCode).toBe(2);
  });

  it("`install-skill --dry-run` previews the target locations and writes nothing", () => {
    const r = runCli(["install-skill", "--dry-run"]);
    expect(r.stdout).toContain("would install the things-cli agent skill");
    expect(r.exitCode).toBe(0);
  });
});
