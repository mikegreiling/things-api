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

describe("view header preambles (TTY-only)", () => {
  // Simulate (or clear) a terminal in-process; runRead gates the header on the
  // live process.stdout.isTTY. Colors stay off (style.ts caches non-TTY at
  // module load), so the header renders as plain, assertable text.
  const withTty = <T>(value: boolean | undefined, fn: () => T): T => {
    const original = process.stdout.isTTY;
    (process.stdout as { isTTY: boolean | undefined }).isTTY = value;
    try {
      return fn();
    } finally {
      (process.stdout as { isTTY: boolean | undefined }).isTTY = original;
    }
  };

  it("prepends the bold title + dim deep link on a TTY", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "capture me", start: "inbox" });
    const { stdout } = withTty(true, () => runCli(["inbox", "--db", fx!.path]));
    expect(stdout.startsWith("Inbox (things:///show?id=inbox)\n\n")).toBe(true);
    expect(stdout).toContain("capture me");
  });

  it("suppresses the header off a TTY so piped output stays clean", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "capture me", start: "inbox" });
    const { stdout } = withTty(undefined, () => runCli(["inbox", "--db", fx!.path]));
    expect(stdout).not.toContain("things:///show?id=inbox");
    expect(stdout).toContain("capture me");
  });

  it("never adds the header to --json, even on a TTY", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "capture me", start: "inbox" });
    const { stdout } = withTty(true, () => runCli(["inbox", "--json", "--db", fx!.path]));
    const envelope = JSON.parse(stdout);
    expect(envelope.kind).toBe("inbox");
    expect(stdout).not.toContain("things:///show?id=inbox");
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

describe("cli anytime — per-block preview (--area-limit / --project-limit)", () => {
  function seedCatalogue(): void {
    const area = seedArea(fx!.db, "Hobbies");
    const proj = seedProject(fx!.db, { title: "Firmware", area, index: 1 });
    for (let i = 0; i < 8; i++) seedTodo(fx!.db, { title: `fw ${i}`, project: proj, index: i });
    for (let i = 0; i < 5; i++) seedTodo(fx!.db, { title: `loose ${i}`, index: 100 + i });
  }

  it("defaults: 30 per area block, 3 per project block, with per-block grouped meta", () => {
    fx = buildFixtureDb();
    seedCatalogue();
    const { stdout, exitCode } = runCli(["anytime", "--json", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.meta.grouped.truncated).toBe(true);
    const blocks = env.meta.grouped.blocks as Array<{
      kind: string;
      total: number;
      shown: number;
      limit: number | null;
    }>;
    expect(blocks).toEqual(
      expect.arrayContaining([
        { kind: "loose", uuid: null, title: null, shown: 5, total: 5, limit: 30 },
        expect.objectContaining({
          kind: "project",
          title: "Firmware",
          shown: 3,
          total: 8,
          limit: 3,
        }),
      ]),
    );
    // The project ROW is always present even though its children were capped.
    const firmware = env.data
      .flatMap((s: { items: { title?: string; type: string }[] }) => s.items)
      .find((i: { title?: string }) => i.title === "Firmware");
    expect(firmware.type).toBe("project");
  });

  it("human output drills into truncated blocks and escalates the caps that hit", () => {
    fx = buildFixtureDb();
    seedCatalogue();
    const { stdout } = runCli(["anytime", "--db", fx.path]);
    expect(stdout).toContain("… 5 more — `things project show 'Firmware'`");
    expect(stdout).toContain("`things anytime --project-limit 6`");
    expect(stdout).toContain("`things anytime --all`");
    // Only the project cap hit — no area-limit escalation.
    expect(stdout).not.toContain("--area-limit");
  });

  it("--area-limit truncates area-direct lists with an area drill-down", () => {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "Busy");
    for (let i = 0; i < 6; i++) seedTodo(fx.db, { title: `direct ${i}`, area, index: i });
    const { stdout } = runCli(["anytime", "--area-limit", "2", "--db", fx.path]);
    expect(stdout).toContain("… 4 more — `things area show 'Busy'`");
    expect(stdout).toContain("`things anytime --area-limit 4`");
  });

  it("--project-limit raises the per-project cap; --all lifts everything", () => {
    fx = buildFixtureDb();
    seedCatalogue();
    const five = JSON.parse(
      runCli(["anytime", "--project-limit", "5", "--json", "--db", fx.path]).stdout,
    );
    const fwBlock = five.meta.grouped.blocks.find(
      (b: { title?: string }) => b.title === "Firmware",
    );
    expect(fwBlock.shown).toBe(5);

    const all = JSON.parse(runCli(["anytime", "--all", "--json", "--db", fx.path]).stdout);
    expect(all.meta.grouped.truncated).toBe(false);
    expect(runCli(["anytime", "--all", "--db", fx.path]).stdout).not.toContain("more per group");
  });

  it("--limit is a usage error on anytime/someday; caps validate; --all conflicts", () => {
    fx = buildFixtureDb();
    seedCatalogue();
    for (const argv of [
      ["anytime", "--limit", "10"],
      ["someday", "--limit", "10"],
      ["anytime", "--area-limit", "0"],
      ["anytime", "--project-limit", "nope"],
      ["anytime", "--area-limit", "5", "--all"],
      ["someday", "--area-limit", "5", "--all"],
    ]) {
      expect(runCli([...argv, "--db", fx.path]).exitCode, argv.join(" ")).toBe(2);
    }
  });
});

describe("cli someday — GUI parity + --show-active-project-items", () => {
  function seedSomedayWorld(): { active: string } {
    const area = seedArea(fx!.db, "Hobbies");
    // A someday PROJECT (renders as a plain row inside the group).
    seedProject(fx!.db, { title: "Dormant Proj", area, start: "someday", index: 1 });
    // Direct someday to-dos, seeded BEFORE the project by drag index to prove
    // the projects-first reorder.
    seedTodo(fx!.db, { title: "someday direct A", area, start: "someday", index: 0 });
    seedTodo(fx!.db, { title: "someday direct B", area, start: "someday", index: 2 });
    // An ACTIVE project holding someday children (the toggle's content).
    const active = seedProject(fx!.db, { title: "Active Proj", area, index: 3 });
    for (let i = 0; i < 4; i++) {
      seedTodo(fx!.db, { title: `parked ${i}`, project: active, start: "someday", index: 10 + i });
    }
    return { active };
  }

  it("lists project rows FIRST within a group, as plain rows (no header blocks)", () => {
    fx = buildFixtureDb();
    seedSomedayWorld();
    const { stdout, exitCode } = runCli(["someday", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const lines = stdout.split("\n");
    const proj = lines.findIndex((l) => l.includes("Dormant Proj"));
    const a = lines.findIndex((l) => l.includes("someday direct A"));
    const b = lines.findIndex((l) => l.includes("someday direct B"));
    expect(proj).toBeGreaterThan(-1);
    expect(proj).toBeLessThan(a);
    expect(a).toBeLessThan(b);
    // Plain row: someday circle mark, count chip, and NO blank line around it.
    expect(lines[proj]).toContain("(~)");
    expect(lines[proj + 1]).not.toBe("");
    // JSON data carries the same projects-first order.
    const env = JSON.parse(runCli(["someday", "--json", "--db", fx.path]).stdout);
    const titles = env.data.flatMap((s: { items: { title: string }[] }) =>
      s.items.map((i) => i.title),
    );
    expect(titles.indexOf("Dormant Proj")).toBeLessThan(titles.indexOf("someday direct A"));
  });

  it("splits a truncated group's remainder by type (projects vs to-dos)", () => {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "Mixed");
    seedProject(fx.db, { title: "SD Proj 1", area, start: "someday", index: 1 });
    seedProject(fx.db, { title: "SD Proj 2", area, start: "someday", index: 2 });
    for (let i = 0; i < 3; i++) {
      seedTodo(fx.db, { title: `sd todo ${i}`, area, start: "someday", index: 10 + i });
    }
    // Cap 1: hidden = 1 project + 3 to-dos (projects list first).
    const both = runCli(["someday", "--area-limit", "1", "--db", fx.path]).stdout;
    expect(both).toContain("… 1 more project, 3 more to-dos — `things area show 'Mixed'`");
    // Cap 2: both projects shown — the project part is omitted.
    const todosOnly = runCli(["someday", "--area-limit", "2", "--db", fx.path]).stdout;
    expect(todosOnly).toContain("… 3 more to-dos — `things area show 'Mixed'`");
    expect(todosOnly).not.toContain("more project");
    // Cap 4: a single hidden to-do stays singular.
    const singular = runCli(["someday", "--area-limit", "4", "--db", fx.path]).stdout;
    expect(singular).toContain("… 1 more to-do — `things area show 'Mixed'`");
    // JSON meta carries the additive type split on the mixed block.
    const env = JSON.parse(
      runCli(["someday", "--area-limit", "1", "--json", "--db", fx.path]).stdout,
    );
    expect(env.meta.grouped.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "area",
          title: "Mixed",
          shown: 1,
          total: 5,
          totalProjects: 2,
          totalTodos: 3,
        }),
      ]),
    );
  });

  it("hides active-project items by default, with a muted counting hint", () => {
    fx = buildFixtureDb();
    seedSomedayWorld();
    const { stdout } = runCli(["someday", "--db", fx.path]);
    expect(stdout).not.toContain("parked 0");
    expect(stdout).not.toContain("From active projects");
    expect(stdout).toContain(
      "(4 someday to-dos inside active projects — visible with `things someday --show-active-project-items`)",
    );
  });

  it("--show-active-project-items appends a trailing flat section of project blocks", () => {
    fx = buildFixtureDb();
    seedSomedayWorld();
    const { stdout, exitCode } = runCli([
      "someday",
      "--show-active-project-items",
      "--db",
      fx.path,
    ]);
    expect(exitCode).toBe(0);
    const lines = stdout.split("\n");
    const divider = lines.findIndex((l) => l.includes("── From active projects ──"));
    const header = lines.findIndex((l) => l.includes("Active Proj"));
    const child = lines.findIndex((l) => l.includes("parked 0"));
    // Divider AFTER all sidebar groups, project header inside it, children beneath.
    expect(divider).toBeGreaterThan(lines.findIndex((l) => l.includes("someday direct B")));
    expect(header).toBeGreaterThan(divider);
    expect(child).toBeGreaterThan(header);
    // Bare flag shows EVERY child; children drop the redundant (project) suffix.
    expect(stdout).toContain("parked 3");
    expect(lines[child]).not.toContain("(Active Proj)");
    // The trailing header is a container header, not an item row: no box glyph.
    expect(lines[header]).not.toContain("( )");
    // No hidden-items hint when the section is shown.
    expect(stdout).not.toContain("visible with");
  });

  it("a numeric value caps each project block and escalates in the bottom line", () => {
    fx = buildFixtureDb();
    seedSomedayWorld();
    const { stdout } = runCli(["someday", "--show-active-project-items", "2", "--db", fx.path]);
    expect(stdout).toContain("parked 1");
    expect(stdout).not.toContain("parked 2");
    expect(stdout).toContain("… 2 more — `things project show 'Active Proj'`");
    expect(stdout).toContain("--show-active-project-items 4");
    // JSON meta carries the per-project block with its cap.
    const env = JSON.parse(
      runCli(["someday", "--show-active-project-items", "2", "--json", "--db", fx.path]).stdout,
    );
    expect(env.meta.grouped.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "project",
          title: "Active Proj",
          shown: 2,
          total: 4,
          limit: 2,
        }),
      ]),
    );
    // Numeric value conflicts with --all.
    expect(
      runCli(["someday", "--show-active-project-items", "2", "--all", "--db", fx.path]).exitCode,
    ).toBe(2);
  });
});

describe("cli --db validation", () => {
  it("an empty --db is a loud usage error, not a fallthrough to the default database", () => {
    for (const argv of [
      ["inbox", "--db", ""],
      ["someday", "--db", "  "],
      ["search", "x", "--db", ""],
    ]) {
      const { exitCode } = runCli(argv);
      expect(exitCode, argv.join(" ")).toBe(2);
    }
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
