import { afterEach, describe, expect, it } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { localToday } from "../../src/model/dates.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTag, seedTodo, tagTask } from "../fixtures/seed.ts";

let fx: FixtureDb | null = null;
afterEach(() => {
  fx?.close();
  fx = null;
});

/** Run the CLI in-process, capturing stdout lines. */
function runCli(argv: string[]): { stdout: string; exitCode: number } {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  const originalExitCode = process.exitCode;
  try {
    const program = buildProgram();
    program.exitOverride();
    program.parse(argv, { from: "user" });
    return { stdout: chunks.join(""), exitCode: Number(process.exitCode ?? 0) };
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = originalExitCode;
  }
}

describe("cli end-to-end (fixture db)", () => {
  it("things today --json emits the versioned envelope with split sections", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "morning", startDate: "2020-01-01", todayIndex: 1 });
    // evening membership requires startDate == today exactly (the CLI path
    // uses the real clock, so seed the actual current date)
    seedTodo(fx.db, { title: "tonight", startDate: localToday(), evening: true });

    const { stdout, exitCode } = runCli(["today", "--json", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout);
    expect(envelope.apiVersion).toBe(1);
    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe("today");
    expect(envelope.meta.dbVersion).toBe(26);
    expect(envelope.meta.fingerprint).toBe("ok");
    expect(envelope.data.today.map((i: { title: string }) => i.title)).toEqual(["morning"]);
    expect(envelope.data.evening.map((i: { title: string }) => i.title)).toEqual(["tonight"]);
  });

  it("things todo show includes checklist and repeating flags", () => {
    fx = buildFixtureDb();
    const uuid = seedTodo(fx.db, { title: "template", recurrenceRule: true });
    const { stdout, exitCode } = runCli(["todo", "show", uuid, "--json", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout);
    expect(envelope.data.repeating.isTemplate).toBe(true);
    expect(envelope.data.checklist).toEqual([]);
  });

  it("things snapshot --json counts every row class", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "a" });
    seedTodo(fx.db, { title: "tpl", recurrenceRule: true });
    seedTodo(fx.db, { title: "junk", trashed: true });
    const { stdout } = runCli(["snapshot", "--json", "--db", fx.path]);
    const envelope = JSON.parse(stdout);
    expect(envelope.data.counts.todos).toBe(3);
    expect(envelope.data.counts.trashed).toBe(1);
    expect(envelope.data.counts.repeatingTemplates).toBe(1);
    expect(envelope.data.tasks).toHaveLength(3);
  });

  it("missing db yields environment error envelope (exit 7)", () => {
    const { stdout, exitCode } = runCli(["inbox", "--json", "--db", "/nope/missing.sqlite"]);
    expect(exitCode).toBe(7);
    const envelope = JSON.parse(stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("environment");
  });
});

describe("cli search (Phase 12 ergonomics)", () => {
  it("defaults to open+untrashed; --all restores the legacy scope", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "report draft" });
    seedTodo(fx.db, { title: "report final", status: "completed" });
    seedTodo(fx.db, { title: "report scrap", trashed: true });

    const open = runCli(["search", "report", "--json", "--db", fx.path]);
    expect(open.exitCode).toBe(0);
    expect(JSON.parse(open.stdout).data.map((i: { title: string }) => i.title)).toEqual([
      "report draft",
    ]);

    const all = runCli(["search", "report", "--all", "--json", "--db", fx.path]);
    expect(JSON.parse(all.stdout).data).toHaveLength(3);

    const logged = runCli(["search", "report", "--logged", "--json", "--db", fx.path]);
    expect(JSON.parse(logged.stdout).data).toHaveLength(2);
  });

  it("--limit and --type narrow; unknown --tag fails loudly", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "alpha one" });
    seedTodo(fx.db, { title: "alpha two" });

    const limited = runCli(["search", "alpha", "--limit", "1", "--json", "--db", fx.path]);
    expect(JSON.parse(limited.stdout).data).toHaveLength(1);

    const typed = runCli(["search", "alpha", "--type", "project", "--json", "--db", fx.path]);
    expect(JSON.parse(typed.stdout).data).toHaveLength(0);

    const bad = runCli(["search", "alpha", "--tag", "nope", "--json", "--db", fx.path]);
    expect(bad.exitCode).not.toBe(0);
    expect(JSON.parse(bad.stdout).error.message).toMatch(/tag not found/);
  });
});

describe("cli list limits + truncation hint", () => {
  function seedInbox(n: number, tag?: string): void {
    const t = tag !== undefined ? seedTag(fx!.db, tag) : null;
    for (let i = 0; i < n; i++) {
      const uuid = seedTodo(fx!.db, { title: `cap ${i}`, start: "inbox", index: i });
      if (t !== null) tagTask(fx!.db, uuid, t);
    }
  }

  it("caps flat views at 50 by default and carries exact pagination meta", () => {
    fx = buildFixtureDb();
    seedInbox(60);
    const { stdout, exitCode } = runCli(["inbox", "--json", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.data).toHaveLength(50);
    expect(env.meta.pagination).toEqual({ shown: 50, total: 60, limit: 50, truncated: true });
  });

  it("human output appends a hint reconstructing the invocation (bigger limit + all)", () => {
    fx = buildFixtureDb();
    seedInbox(60);
    const { stdout } = runCli(["inbox", "--db", fx.path]);
    expect(stdout).toContain("10 more items");
    expect(stdout).toContain("see more: `things inbox --limit 100`");
    expect(stdout).toContain("all: `things inbox --all`");
  });

  it("the hint echoes the flags the user actually passed", () => {
    fx = buildFixtureDb();
    seedInbox(60, "work");
    const { stdout } = runCli(["inbox", "--tag", "work", "--db", fx.path]);
    expect(stdout).toContain("`things inbox --tag work --limit 100`");
    expect(stdout).toContain("`things inbox --tag work --all`");
  });

  it("--limit overrides the cap and the hint escalates from it", () => {
    fx = buildFixtureDb();
    seedInbox(60);
    const json = runCli(["inbox", "--limit", "20", "--json", "--db", fx.path]);
    expect(JSON.parse(json.stdout).data).toHaveLength(20);
    expect(JSON.parse(json.stdout).meta.pagination).toEqual({
      shown: 20,
      total: 60,
      limit: 20,
      truncated: true,
    });
    const human = runCli(["inbox", "--limit", "20", "--db", fx.path]);
    expect(human.stdout).toContain("40 more items");
    expect(human.stdout).toContain("--limit 40");
  });

  it("--all lifts the cap entirely — no truncation, no hint", () => {
    fx = buildFixtureDb();
    seedInbox(60);
    const json = runCli(["inbox", "--all", "--json", "--db", fx.path]);
    expect(JSON.parse(json.stdout).data).toHaveLength(60);
    expect(JSON.parse(json.stdout).meta.pagination.truncated).toBe(false);
    const human = runCli(["inbox", "--all", "--db", fx.path]);
    expect(human.stdout).not.toContain("more items");
  });

  it("rejects a non-positive/non-integer --limit and --limit+--all", () => {
    fx = buildFixtureDb();
    seedInbox(3);
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const r = runCli(["inbox", "--limit", bad, "--db", fx.path]);
      expect(r.exitCode).toBe(2);
    }
    const conflict = runCli(["inbox", "--limit", "10", "--all", "--db", fx.path]);
    expect(conflict.exitCode).toBe(2);
  });

  it("upcoming --all does not combine with --since/--until", () => {
    fx = buildFixtureDb();
    expect(runCli(["upcoming", "--all", "--since", "2w", "--db", fx.path]).exitCode).toBe(2);
    expect(runCli(["upcoming", "--all", "--until", "3m", "--db", fx.path]).exitCode).toBe(2);
  });

  it("changes --since accepts the relative-period vocabulary", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "recent" });
    const { stdout, exitCode } = runCli(["changes", "--since", "1y", "--json", "--db", fx.path]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
  });
});

describe("cli grouped views — per-block preview (anytime/someday)", () => {
  function seedCatalogue(): void {
    const area = seedArea(fx!.db, "Hobbies");
    const proj = seedProject(fx!.db, { title: "Firmware", area, index: 1 });
    for (let i = 0; i < 8; i++) seedTodo(fx!.db, { title: `fw ${i}`, project: proj, index: i });
    for (let i = 0; i < 5; i++) seedTodo(fx!.db, { title: `loose ${i}`, index: 100 + i });
  }

  it("previews 3 items per block by default with per-block grouped meta", () => {
    fx = buildFixtureDb();
    seedCatalogue();
    const { stdout, exitCode } = runCli(["anytime", "--json", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.meta.grouped.truncated).toBe(true);
    expect(env.meta.grouped.limit).toBe(3);
    // Both the loose block and the project block are capped and counted.
    const blocks = env.meta.grouped.blocks as Array<{ kind: string; total: number; shown: number }>;
    expect(blocks).toEqual(
      expect.arrayContaining([
        { kind: "loose", uuid: null, title: null, shown: 3, total: 5 },
        expect.objectContaining({ kind: "project", title: "Firmware", shown: 3, total: 8 }),
      ]),
    );
    // The project ROW is always present even though its children were capped.
    const firmware = env.data
      .flatMap((s: { items: { title?: string; type: string }[] }) => s.items)
      .find((i: { title?: string }) => i.title === "Firmware");
    expect(firmware.type).toBe("project");
  });

  it("human output drills into truncated blocks and points at --limit/--all", () => {
    fx = buildFixtureDb();
    seedCatalogue();
    const { stdout } = runCli(["anytime", "--db", fx.path]);
    expect(stdout).toContain("… 5 more — `things project show 'Firmware'`");
    expect(stdout).toContain("… 2 more"); // the loose block (5 total, 3 shown) — no drill-down
    expect(stdout).toContain("`things anytime --limit 6`");
    expect(stdout).toContain("`things anytime --all`");
  });

  it("--limit sets a bigger per-block cap; --all lifts it entirely", () => {
    fx = buildFixtureDb();
    seedCatalogue();
    const five = JSON.parse(runCli(["anytime", "--limit", "5", "--json", "--db", fx.path]).stdout);
    const fwBlock = five.meta.grouped.blocks.find(
      (b: { title?: string }) => b.title === "Firmware",
    );
    expect(fwBlock.shown).toBe(5);

    const all = JSON.parse(runCli(["anytime", "--all", "--json", "--db", fx.path]).stdout);
    expect(all.meta.grouped.truncated).toBe(false);
    expect(runCli(["anytime", "--all", "--db", fx.path]).stdout).not.toContain("more per group");
  });
});

describe("cli --exact-tag (Phase 12c)", () => {
  it("inbox --tag works (12a regression) and --exact-tag narrows", () => {
    fx = buildFixtureDb();
    const parent = seedTag(fx.db, "ctx");
    const child = seedTag(fx.db, "ctx-child", parent);
    const a = seedTodo(fx.db, { title: "inbox-parent", start: "inbox" });
    tagTask(fx.db, a, parent);
    const b = seedTodo(fx.db, { title: "inbox-child", start: "inbox" });
    tagTask(fx.db, b, child);

    const both = runCli(["inbox", "--tag", "ctx", "--json", "--db", fx.path]);
    expect(JSON.parse(both.stdout).data).toHaveLength(2);
    const exact = runCli(["inbox", "--tag", "ctx", "--exact-tag", "--json", "--db", fx.path]);
    expect(JSON.parse(exact.stdout).data.map((i: { title: string }) => i.title)).toEqual([
      "inbox-parent",
    ]);
  });
});

describe("cli changes (Phase 13)", () => {
  it("lists created/modified since --since with markers", () => {
    fx = buildFixtureDb();
    const SINCE = 1_790_000_000;
    seedTodo(fx.db, { title: "untouched", creationDate: SINCE - 10, modificationDate: SINCE - 10 });
    seedTodo(fx.db, { title: "fresh", creationDate: SINCE + 5, modificationDate: SINCE + 5 });
    const sinceIso = new Date(SINCE * 1000).toISOString();
    const { stdout, exitCode } = runCli([
      "changes",
      "--since",
      sinceIso,
      "--json",
      "--db",
      fx.path,
    ]);
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout).data;
    expect(data).toHaveLength(1);
    expect(data[0].title).toBe("fresh");
    expect(data[0].changeKind).toBe("created");

    const bad = runCli(["changes", "--since", "not-a-date", "--db", fx.path]);
    expect(bad.exitCode).toBe(2);
  });
});
