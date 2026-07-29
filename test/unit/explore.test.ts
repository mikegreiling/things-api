import { afterAll, describe, expect, it } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import {
  READ_SUBCOMMANDS,
  READ_VIEWS,
  classify,
  startExploreServer,
  tokenize,
} from "../../scripts/explore/server.ts";
import { buildFixtureDb } from "../fixtures/build-db.ts";

describe("explore tokenizer", () => {
  it("splits on whitespace and honors double and single quotes", () => {
    expect(tokenize('area show "Home base" --show-later')).toEqual([
      "area",
      "show",
      "Home base",
      "--show-later",
    ]);
    expect(tokenize("search 'two words'")).toEqual(["search", "two words"]);
    expect(tokenize("  today   --json ")).toEqual(["today", "--json"]);
  });

  it("rejects unbalanced quotes", () => {
    expect(() => tokenize('search "unterminated')).toThrow(/unbalanced/);
    expect(() => tokenize("search 'unterminated")).toThrow(/unbalanced/);
  });
});

describe("explore classifier", () => {
  it("runs allowlisted reads verbatim, appending only --json", () => {
    for (const view of ["inbox", "today", "anytime", "capabilities", "legend"]) {
      const c = classify([view]);
      expect(c.kind).toBe("run");
      expect(c.argv).toEqual([view, "--json"]);
      expect(c.forced).toEqual(["--json"]);
    }
    const sub = classify(["todo", "show", "some-uuid"]);
    expect(sub.argv).toEqual(["todo", "show", "some-uuid", "--json"]);
  });

  it("strips a leading `things` token", () => {
    expect(classify(["things", "today"]).argv).toEqual(["today", "--json"]);
  });

  it("treats bare trash as a read but trash empty as a mutation", () => {
    expect(classify(["trash"]).argv).toEqual(["trash", "--json"]);
    expect(classify(["trash", "empty"]).argv).toEqual(["trash", "empty", "--dry-run", "--json"]);
  });

  it("force-appends --dry-run to everything off the allowlist", () => {
    const c = classify(["todo", "complete", "abc"]);
    expect(c.argv).toEqual(["todo", "complete", "abc", "--dry-run", "--json"]);
    expect(c.forced).toContain("--dry-run");
    expect(classify(["undo"]).argv).toEqual(["undo", "--dry-run", "--json"]);
    expect(classify(["config", "set", "k", "v"]).argv).toEqual([
      "config",
      "set",
      "k",
      "v",
      "--dry-run",
      "--json",
    ]);
  });

  it("never duplicates flags the user already passed", () => {
    expect(classify(["todo", "add", "T", "--dry-run", "--json"]).forced).toEqual([]);
    expect(classify(["today", "--json"]).forced).toEqual([]);
  });

  it("refuses batch and mcp outright", () => {
    expect(classify(["batch"]).kind).toBe("refused");
    expect(classify(["mcp"]).kind).toBe("refused");
  });

  it("passes help through without --json", () => {
    expect(classify(["help"]).argv).toEqual(["help"]);
  });
});

describe("explore allowlist stays in sync with the CLI registry", () => {
  const program = buildProgram();
  const names = new Set(program.commands.flatMap((c) => [c.name(), ...c.aliases()]));

  it("every allowlisted view is a registered command", () => {
    for (const view of READ_VIEWS) expect(names, view).toContain(view);
  });

  it("every allowlisted noun/sub pair is registered", () => {
    for (const [noun, sub] of READ_SUBCOMMANDS) {
      const cmd = program.commands.find((c) => c.name() === noun || c.aliases().includes(noun));
      expect(cmd, noun).toBeDefined();
      expect(
        cmd!.commands.map((s) => s.name()),
        `${noun} ${sub}`,
      ).toContain(sub);
    }
  });
});

describe("explore server smoke", () => {
  const fx = buildFixtureDb();
  const originalDb = process.env["THINGS_DB"];
  process.env["THINGS_DB"] = fx.path;

  afterAll(() => {
    if (originalDb === undefined) delete process.env["THINGS_DB"];
    else process.env["THINGS_DB"] = originalDb;
    fx.close();
  });

  it("serves the page and runs a read against the fixture db", { timeout: 30_000 }, async () => {
    const server = await startExploreServer({ port: 0 });
    try {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const base = `http://127.0.0.1:${port}`;

      const page = await fetch(base + "/");
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("things explore");

      const read = await fetch(base + "/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "inbox" }),
      });
      const readResult = (await read.json()) as {
        stdout: string;
        exitCode: number;
        argv: string[];
      };
      expect(readResult.exitCode).toBe(0);
      expect(readResult.argv).toEqual(["inbox", "--json"]);
      const envelope = JSON.parse(readResult.stdout) as { ok: boolean; kind: string };
      expect(envelope.ok).toBe(true);
      expect(envelope.kind).toBe("inbox");

      const write = await fetch(base + "/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "todo complete nonexistent-uuid-0001" }),
      });
      const writeResult = (await write.json()) as { argv: string[]; forced: string[] };
      expect(writeResult.argv).toContain("--dry-run");
      expect(writeResult.forced).toContain("--dry-run");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
