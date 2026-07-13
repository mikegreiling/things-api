import { afterEach, describe, expect, it } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { resolveInvocation } from "../../src/cli/resolve-invocation.ts";
import { localToday } from "../../src/model/dates.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTag, seedTodo, tagTask } from "../fixtures/seed.ts";

let fx: FixtureDb | null = null;
afterEach(() => {
  fx?.close();
  fx = null;
});

/** The TTY-only preamble a headered view leads with (title + its deep link). */
function viewPreamble(view: string): string {
  return `${view.charAt(0).toUpperCase()}${view.slice(1)} (things:///show?id=${view})`;
}

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
    // Route through the same resolver the real CLI applies.
    program.parse(resolveInvocation(program, argv).argv, { from: "user" });
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

  // Every headered view, matrixed so a future view wired WITHOUT the header
  // arg (or added here without wiring) fails a test. The command name is also
  // the deep-link id; the title is that name capitalized (viewHeaderLines).
  const HEADERED_VIEWS = [
    "today",
    "inbox",
    "anytime",
    "someday",
    "upcoming",
    "logbook",
    "trash",
  ] as const;

  for (const view of HEADERED_VIEWS) {
    describe(view, () => {
      it("prepends the bold title + dim deep link on a TTY", () => {
        fx = buildFixtureDb();
        seedTodo(fx.db, { title: "capture me", start: "inbox" });
        const { stdout } = withTty(true, () => runCli([view, "--db", fx!.path]));
        expect(stdout.startsWith(`${viewPreamble(view)}\n\n`)).toBe(true);
      });

      it("suppresses the header off a TTY so piped output stays clean", () => {
        fx = buildFixtureDb();
        seedTodo(fx.db, { title: "capture me", start: "inbox" });
        const { stdout } = withTty(undefined, () => runCli([view, "--db", fx!.path]));
        expect(stdout).not.toContain(`things:///show?id=${view}`);
      });

      it("never adds the header to --json, even on a TTY", () => {
        fx = buildFixtureDb();
        seedTodo(fx.db, { title: "capture me", start: "inbox" });
        const { stdout } = withTty(true, () => runCli([view, "--json", "--db", fx!.path]));
        const envelope = JSON.parse(stdout);
        expect(envelope.kind).toBe(view);
        expect(stdout).not.toContain(`things:///show?id=${view}`);
      });
    });
  }
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

describe("cli bare-noun shorthand + show keywords", () => {
  it("things <area name> / <project name> / <todo uuid prefix> route to the right card", () => {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "Hobbies");
    seedProject(fx.db, { title: "Firmware", area, index: 1 });
    const todo = seedTodo(fx.db, { title: "solder joints", index: 1 });

    const areaOut = runCli(["Hobbies", "--db", fx.path]);
    expect(areaOut.exitCode).toBe(0);
    expect(areaOut.stdout).toContain("Area: ⬡ Hobbies");

    const projOut = runCli(["Firmware", "--db", fx.path]);
    expect(projOut.exitCode).toBe(0);
    expect(projOut.stdout).toContain("Project:");
    expect(projOut.stdout).toContain("Firmware");

    const todoOut = runCli([todo.slice(0, 8), "--db", fx.path]);
    expect(todoOut.exitCode).toBe(0);
    expect(todoOut.stdout).toContain("To-Do:");
    expect(todoOut.stdout).toContain("solder joints");

    // Share links route like any ref.
    const linkOut = runCli([`things:///show?id=${todo}`, "--db", fx.path]);
    expect(linkOut.stdout).toContain("To-Do:");
  });

  it("flags pass through the shorthand untouched", () => {
    fx = buildFixtureDb();
    seedArea(fx.db, "Hobbies");
    const { stdout, exitCode } = runCli(["Hobbies", "--json", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.kind).toBe("show");
    expect(env.data.type).toBe("area");
  });

  it("leading global flags route too: `things --json <name>` = `things <name> --json`", () => {
    fx = buildFixtureDb();
    seedArea(fx.db, "Hobbies");

    // --json leading the noun.
    const jsonFirst = runCli(["--json", "Hobbies", "--db", fx.path]);
    expect(jsonFirst.exitCode).toBe(0);
    const env = JSON.parse(jsonFirst.stdout);
    expect(env.kind).toBe("show");
    expect(env.data.type).toBe("area");
    // meta.resolvedCommand rides the same path.
    expect(env.meta.resolvedCommand).toBe("things area show Hobbies");

    // --db <value> leading: the value is never misread as the noun.
    const dbFirst = runCli(["--db", fx.path, "Hobbies", "--json"]);
    expect(dbFirst.exitCode).toBe(0);
    expect(JSON.parse(dbFirst.stdout).data.type).toBe("area");

    // Both flags leading, noun last.
    const bothFirst = runCli(["--json", "--db", fx.path, "Hobbies"]);
    expect(bothFirst.exitCode).toBe(0);
    expect(JSON.parse(bothFirst.stdout).meta.resolvedCommand).toBe("things area show Hobbies");

    // Canary: `things --json` alone (no noun) still errors as before — it is
    // not silently routed anywhere.
    expect(() => runCli(["--json"])).toThrow();
  });

  it("registered command names are reserved and always win", () => {
    fx = buildFixtureDb();
    const legend = runCli(["legend", "--json"]);
    expect(legend.exitCode).toBe(0);
    expect(JSON.parse(legend.stdout).kind).toBe("legend");
    const inbox = runCli(["inbox", "--json", "--db", fx.path]);
    expect(JSON.parse(inbox.stdout).kind).toBe("inbox");
  });

  it("show <view keyword> IS the view, beating a same-named area", () => {
    fx = buildFixtureDb();
    seedArea(fx.db, "Anytime");
    seedTodo(fx.db, { title: "loose now", index: 1 });
    const view = runCli(["show", "anytime", "--json", "--db", fx.path]);
    expect(view.exitCode).toBe(0);
    expect(JSON.parse(view.stdout).kind).toBe("anytime");
    // The typed form remains the escape hatch to the shadowed area.
    const escape = runCli(["area", "show", "Anytime", "--json", "--db", fx.path]);
    expect(JSON.parse(escape.stdout).kind).toBe("area-view");
    // Keyword dispatch accepts the view's own flags.
    const flagged = runCli(["show", "someday", "--area-limit", "5", "--json", "--db", fx.path]);
    expect(JSON.parse(flagged.stdout).kind).toBe("someday");
  });

  it("an unknown bare word errors naming both possibilities", () => {
    fx = buildFixtureDb();
    const { stdout, exitCode } = runCli(["frobnicate", "--json", "--db", fx.path]);
    expect(exitCode).not.toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(false);
    expect(env.error.message).toContain('no command or item named "frobnicate"');
    // Typed `things show <ref>` keeps the plain resolution error.
    const typed = runCli(["show", "frobnicate", "--json", "--db", fx.path]);
    expect(JSON.parse(typed.stdout).error.message).not.toContain("no command or item");
  });

  it("show accepts the plural collection keywords (projects|areas|tags)", () => {
    fx = buildFixtureDb();
    seedArea(fx.db, "Home");
    seedProject(fx.db, { title: "Website", index: 1 });
    for (const kw of ["projects", "areas", "tags"]) {
      const out = runCli(["show", kw, "--json", "--db", fx.path]);
      expect(out.exitCode, kw).toBe(0);
      expect(JSON.parse(out.stdout).kind, kw).toBe(kw);
    }
  });
});

describe("cli normalized-form echo + meta.resolvedCommand", () => {
  it("meta.resolvedCommand names the canonical command for each routing sugar", () => {
    fx = buildFixtureDb();
    seedArea(fx.db, "Hobbies");
    const spaced = seedProject(fx.db, { title: "Website redesign", index: 1 });
    const todo = seedTodo(fx.db, { title: "solder", index: 1 });

    // bare noun (name) → typed area show (plain word: shell-safe, unquoted)
    expect(
      JSON.parse(runCli(["Hobbies", "--json", "--db", fx.path]).stdout).meta.resolvedCommand,
    ).toBe("things area show Hobbies");
    // a multi-word name is quoted (same shellQuote rules as the footers)
    expect(
      JSON.parse(runCli(["Website redesign", "--json", "--db", fx.path]).stdout).meta
        .resolvedCommand,
    ).toBe('things project show "Website redesign"');
    void spaced;
    // keyword-in-show → the view command
    expect(
      JSON.parse(runCli(["show", "anytime", "--json", "--db", fx.path]).stdout).meta
        .resolvedCommand,
    ).toBe("things anytime");
    // uuid routing (bare) → typed todo show, echoing the prefix given
    expect(
      JSON.parse(runCli([todo.slice(0, 8), "--json", "--db", fx.path]).stdout).meta.resolvedCommand,
    ).toBe(`things todo show ${todo.slice(0, 8)}`);
    // share link (loose show) → typed todo show, link stripped to its id
    expect(
      JSON.parse(runCli(["show", `things:///show?id=${todo}`, "--json", "--db", fx.path]).stdout)
        .meta.resolvedCommand,
    ).toBe(`things todo show ${todo}`);
  });

  it("canonical invocations carry no resolvedCommand (no noise)", () => {
    fx = buildFixtureDb();
    seedArea(fx.db, "Hobbies");
    // a plain view command
    expect(
      JSON.parse(runCli(["inbox", "--json", "--db", fx.path]).stdout).meta.resolvedCommand,
    ).toBeUndefined();
    // an already-typed command
    expect(
      JSON.parse(runCli(["area", "show", "Hobbies", "--json", "--db", fx.path]).stdout).meta
        .resolvedCommand,
    ).toBeUndefined();
    // a loose show given a plain NAME is not a routing sugar
    expect(
      JSON.parse(runCli(["show", "Hobbies", "--json", "--db", fx.path]).stdout).meta
        .resolvedCommand,
    ).toBeUndefined();
  });

  it("the echo line renders on a TTY, but never piped and never in --json", () => {
    fx = buildFixtureDb();
    seedArea(fx.db, "Hobbies");
    const path = fx.path;
    // A TTY-forcing harness (the default runCli leaves isTTY falsy = piped).
    const runTty = (argv: string[]): string => {
      const chunks: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      const originalIsTty = process.stdout.isTTY;
      process.stdout.isTTY = true;
      process.stdout.write = ((chunk: string | Uint8Array) => {
        chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
      }) as typeof process.stdout.write;
      const originalExitCode = process.exitCode;
      try {
        const program = buildProgram();
        program.exitOverride();
        program.parse(resolveInvocation(program, argv).argv, { from: "user" });
        return chunks.join("");
      } finally {
        process.stdout.write = originalWrite;
        process.stdout.isTTY = originalIsTty;
        process.exitCode = originalExitCode;
      }
    };

    // On a TTY the bare noun echoes its canonical typed form.
    expect(runTty(["Hobbies", "--db", path])).toContain("≡ things area show Hobbies");
    // Piped (default harness) it is absent.
    expect(runCli(["Hobbies", "--db", path]).stdout).not.toContain("≡ things area show");
    // A canonical TTY invocation echoes nothing.
    expect(runTty(["area", "show", "Hobbies", "--db", path])).not.toContain("≡ things");
    // --json never carries the echo line.
    expect(runCli(["Hobbies", "--json", "--db", path]).stdout).not.toContain("≡");
  });
});

describe("cli open — plural keywords are not openable", () => {
  it("open projects/areas/tags error with the fix, launching nothing", () => {
    fx = buildFixtureDb();
    const cases: Array<readonly [string, string]> = [
      ["projects", "project"],
      ["areas", "area"],
      ["tags", "item"],
    ];
    for (const [kw, noun] of cases) {
      const out = runCli(["open", kw, "--json", "--db", fx.path]);
      expect(out.exitCode, kw).not.toBe(0);
      const msg = JSON.parse(out.stdout).error.message;
      expect(msg, kw).toContain(`the app has no ${kw} list to open`);
      expect(msg, kw).toContain(`open a specific ${noun}`);
    }
  });
});

describe("cli detail views — area show per-section caps; project show uncapped", () => {
  function seedBusyArea(): void {
    const area = seedArea(fx!.db, "Busy");
    for (let i = 0; i < 35; i++) {
      seedProject(fx!.db, { title: `proj ${String(i).padStart(2, "0")}`, area, index: i });
    }
    for (let i = 0; i < 35; i++) {
      seedTodo(fx!.db, { title: `direct ${String(i).padStart(2, "0")}`, area, index: 100 + i });
    }
  }

  it("area show caps project rows and direct to-dos at 30 each, with per-section footers", () => {
    fx = buildFixtureDb();
    seedBusyArea();
    const { stdout, exitCode } = runCli(["area", "show", "Busy", "--db", fx.path]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("proj 29");
    expect(stdout).not.toContain("proj 30");
    expect(stdout).toContain("direct 29");
    expect(stdout).not.toContain("direct 30");
    expect(stdout).toContain("… 5 more projects — `things area show Busy --project-limit 60`");
    expect(stdout).toContain("… 5 more to-dos — `things area show Busy --area-limit 60`");
    // The card preamble always renders.
    expect(stdout).toContain("Area: ⬡ Busy");
  });

  it("the knobs adjust independently; --all lifts both; JSON carries grouped counts", () => {
    fx = buildFixtureDb();
    seedBusyArea();
    const tty = runCli([
      "area",
      "show",
      "Busy",
      "--project-limit",
      "2",
      "--area-limit",
      "3",
      "--db",
      fx.path,
    ]).stdout;
    expect(tty).toContain("… 33 more projects — `things area show Busy --project-limit 4`");
    expect(tty).toContain("… 32 more to-dos — `things area show Busy --area-limit 6`");

    const json = JSON.parse(
      runCli([
        "area",
        "show",
        "Busy",
        "--project-limit",
        "2",
        "--area-limit",
        "3",
        "--json",
        "--db",
        fx.path,
      ]).stdout,
    );
    expect(json.data.projects).toHaveLength(2);
    expect(json.data.active).toHaveLength(3);
    expect(json.meta.grouped).toEqual({
      truncated: true,
      blocks: [
        expect.objectContaining({ kind: "projects", title: "Busy", shown: 2, total: 35, limit: 2 }),
        expect.objectContaining({ kind: "area", title: "Busy", shown: 3, total: 35, limit: 3 }),
      ],
    });

    const all = JSON.parse(
      runCli(["area", "show", "Busy", "--all", "--json", "--db", fx.path]).stdout,
    );
    expect(all.data.projects).toHaveLength(35);
    expect(all.data.active).toHaveLength(35);
    expect(all.meta.grouped.truncated).toBe(false);
    expect(runCli(["area", "show", "Busy", "--all", "--db", fx.path]).stdout).not.toContain("more");
  });

  it("--limit is a usage error on area show and the loose show; knobs validate", () => {
    fx = buildFixtureDb();
    seedBusyArea();
    for (const argv of [
      ["area", "show", "Busy", "--limit", "10"],
      ["show", "Busy", "--limit", "10"],
      ["area", "show", "Busy", "--area-limit", "0"],
      ["area", "show", "Busy", "--project-limit", "nope"],
      ["area", "show", "Busy", "--area-limit", "5", "--all"],
    ]) {
      expect(runCli([...argv, "--db", fx.path]).exitCode, argv.join(" ")).toBe(2);
    }
  });

  it("project show is UNCAPPED (headings are true containers); --limit is unknown there", () => {
    fx = buildFixtureDb();
    const proj = seedProject(fx.db, { title: "Big Proj", index: 1 });
    for (let i = 0; i < 60; i++) {
      seedTodo(fx.db, { title: `task ${String(i).padStart(2, "0")}`, project: proj, index: i });
    }
    const tty = runCli(["project", "show", "Big Proj", "--db", fx.path]);
    expect(tty.exitCode).toBe(0);
    expect(tty.stdout).toContain("task 59");
    expect(tty.stdout).not.toContain("more items");
    const json = JSON.parse(
      runCli(["project", "show", "Big Proj", "--json", "--db", fx.path]).stdout,
    );
    expect(json.data.active).toHaveLength(60);
    expect(json.meta.pagination).toBeUndefined();
    // No --limit exists on project show at all — commander rejects it as an
    // unknown option (error + non-zero exit in the real CLI).
    expect(() =>
      runCli(["project", "show", "Big Proj", "--limit", "5", "--db", fx!.path]),
    ).toThrow();
  });

  it("the loose show router caps area payloads per section, projects not at all", () => {
    fx = buildFixtureDb();
    seedBusyArea();
    const json = JSON.parse(runCli(["show", "Busy", "--json", "--db", fx.path]).stdout);
    expect(json.kind).toBe("show");
    expect(json.data.type).toBe("area");
    expect(json.data.view.projects).toHaveLength(30);
    expect(json.meta.grouped.truncated).toBe(true);
    // …and via the bare shorthand, knobs intact (footer echoes `things show …`).
    const tty = runCli(["Busy", "--area-limit", "3", "--db", fx.path]);
    expect(tty.stdout).toContain("… 32 more to-dos — `things show Busy --area-limit 6`");
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
