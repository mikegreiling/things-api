import { afterEach, describe, expect, it } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { resolveInvocation } from "../../src/cli/resolve-invocation.ts";
import { localToday } from "../../src/model/dates.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import {
  seedArea,
  seedHeading,
  seedProject,
  seedTag,
  seedTodo,
  tagArea,
  tagTask,
} from "../fixtures/seed.ts";

let fx: FixtureDb | null = null;
afterEach(() => {
  fx?.close();
  fx = null;
});

/** The TTY-only preamble a headered view leads with (title + its deep link). */
function viewPreamble(view: string): string {
  return `${view.charAt(0).toUpperCase()}${view.slice(1)} (things:///show?id=${view})`;
}

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

/** ISO calendar date `days` from the real today (the CLI uses the real clock). */
function isoFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const titlesOf = (stdout: string): string[] =>
  JSON.parse(stdout).data.map((i: { title: string }) => i.title);

/** Epoch SECONDS `daysAgo` before the real now (the CLI uses the real clock). */
const epoch = (daysAgo: number): number => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.getTime() / 1000;
};

/** A TTY-forcing harness (the default runCli leaves isTTY falsy = piped). */
function runTty(argv: string[]): string {
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

/**
 * Async variant for WRITE commands (their actions await): capture stdout across
 * the awaited parseAsync. Used only for reference-resolution errors, which throw
 * BEFORE the mutation lock/audit stage, so they touch no state.
 */
async function runCliAsync(argv: string[]): Promise<{ stdout: string; exitCode: number }> {
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
    await program.parseAsync(resolveInvocation(program, argv).argv, { from: "user" });
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

  it("things today puts ★/⏾ in the section headers, not on the rows", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "morning", startDate: localToday(), todayIndex: 1 });
    seedTodo(fx.db, { title: "tonight", startDate: localToday(), evening: true });
    const { stdout, exitCode } = runCli(["today", "--db", fx.path]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("★ Today (badge:");
    expect(stdout).toContain("⏾ This Evening ──");
    // The membership glyph is gone from the item rows themselves.
    const rows = stdout.split("\n").filter((l) => l.includes("morning") || l.includes("tonight"));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).not.toContain("★");
      expect(row).not.toContain("⏾");
    }
  });

  it("things today: a cap consuming evening keeps an honest evening hint + the global footer", () => {
    fx = buildFixtureDb();
    // 55 Today + 20 This Evening = 75; the default --limit 50 shows 50 Today
    // rows and NO evening rows, hiding 25 total (5 Today + all 20 evening).
    for (let i = 0; i < 55; i++) {
      seedTodo(fx.db, { title: `day ${i}`, startDate: localToday(), todayIndex: i });
    }
    for (let i = 0; i < 20; i++) {
      seedTodo(fx.db, {
        title: `night ${i}`,
        startDate: localToday(),
        evening: true,
        todayIndex: i,
      });
    }
    const { stdout, exitCode } = runCli(["today", "--db", fx.path]);
    expect(exitCode).toBe(0);
    // This Evening header renders even though every evening row was cut — the
    // section-specific hint replaces the old misleading "(empty)".
    expect(stdout).toContain("⏾ This Evening ──");
    expect(stdout).not.toContain("(empty)");
    // The evening hint is now a pure section pointer — the quantity levers live
    // on the global footer below, so the evening line only names --evening.
    expect(stdout).toContain("… 20 evening items — `things today --evening`");
    // The global footer counts ALL hidden rows (25) — the two compose sensibly.
    expect(stdout).toContain("25 more items");
    expect(stdout).toContain("see more: `things today --limit 100`");
    // Full truncated layout, in order: the evening header, then the evening
    // pointer hint, then a BLANK line separating it from the global footer.
    const lines = stdout.split("\n");
    const evIdx = lines.findIndex((l) => l.includes("This Evening ──"));
    const hintIdx = lines.findIndex((l) => l.includes("evening items — `things today --evening`"));
    const footerIdx = lines.findIndex((l) => l.includes("25 more items"));
    expect(evIdx).toBeGreaterThanOrEqual(0);
    expect(hintIdx).toBeGreaterThan(evIdx);
    expect(footerIdx).toBeGreaterThan(hintIdx);
    // Exactly one blank line between the evening hint and the global footer.
    expect(lines.slice(hintIdx + 1, footerIdx)).toEqual([""]);
    // JSON is unchanged (fields, not glyphs): the split still carries counts.
    const env = JSON.parse(runCli(["today", "--json", "--db", fx.path]).stdout);
    expect(env.data.today).toHaveLength(50);
    expect(env.data.evening).toHaveLength(0);
    expect(env.meta.pagination).toEqual({ shown: 50, total: 75, limit: 50, truncated: true });
  });

  it("things todo show includes checklist and repeating flags", () => {
    fx = buildFixtureDb();
    const uuid = seedTodo(fx.db, { title: "template", recurrenceRule: true });
    const { stdout, exitCode } = runCli(["todo", "show", uuid, "--json", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout);
    expect(envelope.data.repeating.isTemplate).toBe(true);
    // Omit-empty (contracts.md): an empty checklist is absent, not [].
    expect("checklist" in envelope.data).toBe(false);
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
    expect(JSON.parse(bad.stdout).error.message).toMatch(/no tag matching/);
  });
});

describe('cli --untagged (GUI "No Tag")', () => {
  function seedTagged() {
    fx = buildFixtureDb();
    const focus = seedTag(fx.db, "focus");
    const tagged = seedTodo(fx.db, { title: "tagged one", startDate: "2026-07-02" });
    tagTask(fx.db, tagged, focus);
    seedTodo(fx.db, { title: "bare one", startDate: "2026-07-02" });
  }

  it("today --untagged keeps only untagged items (human + JSON)", () => {
    seedTagged();
    const json = runCli(["today", "--untagged", "--json", "--db", fx!.path]);
    expect(json.exitCode).toBe(0);
    const titles = JSON.parse(json.stdout).data.today.map((i: { title: string }) => i.title);
    expect(titles).toEqual(["bare one"]);
    const human = runCli(["today", "--untagged", "--db", fx!.path]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("bare one");
    expect(human.stdout).not.toContain("tagged one");
  });

  it("search --untagged narrows results", () => {
    fx = buildFixtureDb();
    const focus = seedTag(fx.db, "focus");
    const tagged = seedTodo(fx.db, { title: "note tagged" });
    tagTask(fx.db, tagged, focus);
    seedTodo(fx.db, { title: "note bare" });
    const json = runCli(["search", "note", "--untagged", "--json", "--db", fx.path]);
    expect(json.exitCode).toBe(0);
    const titles = JSON.parse(json.stdout).data.map((i: { title: string }) => i.title);
    expect(titles).toEqual(["note bare"]);
  });

  it("--untagged is mutually exclusive with --tag/--exact-tag (usage error)", () => {
    seedTagged();
    for (const view of ["today", "inbox", "anytime", "someday", "upcoming", "logbook", "search"]) {
      const argv =
        view === "search"
          ? ["search", "x", "--untagged", "--tag", "focus", "--db", fx!.path]
          : [view, "--untagged", "--tag", "focus", "--db", fx!.path];
      expect(runCli(argv).exitCode).toBe(2);
    }
    expect(runCli(["today", "--untagged", "--exact-tag", "--db", fx!.path]).exitCode).toBe(2);
  });
});

describe("cli --direct-tag / --direct-untagged / multi-tag AND", () => {
  it("--tag is repeatable and ANDs (foo AND bar; a foo-only item excluded)", () => {
    fx = buildFixtureDb();
    const foo = seedTag(fx.db, "foo");
    const bar = seedTag(fx.db, "bar");
    const both = seedTodo(fx.db, { title: "both", startDate: "2026-07-02" });
    tagTask(fx.db, both, foo);
    tagTask(fx.db, both, bar);
    const fooOnly = seedTodo(fx.db, { title: "foo-only", startDate: "2026-07-02" });
    tagTask(fx.db, fooOnly, foo);
    const json = runCli(["today", "--tag", "foo", "--tag", "bar", "--json", "--db", fx.path]);
    expect(json.exitCode).toBe(0);
    const titles = JSON.parse(json.stdout).data.today.map((i: { title: string }) => i.title);
    expect(titles).toEqual(["both"]);
  });

  it("--direct-tag excludes container-inherited; --direct-untagged keeps inherited-only", () => {
    fx = buildFixtureDb();
    const focus = seedTag(fx.db, "focus");
    const work = seedArea(fx.db, "Work");
    tagArea(fx.db, work, focus);
    const direct = seedTodo(fx.db, { title: "direct", area: work, startDate: "2026-07-02" });
    tagTask(fx.db, direct, focus);
    seedTodo(fx.db, { title: "inherited", area: work, startDate: "2026-07-02" });
    seedTodo(fx.db, { title: "bare", startDate: "2026-07-02" });
    const dt = runCli(["today", "--direct-tag", "focus", "--json", "--db", fx.path]);
    expect(JSON.parse(dt.stdout).data.today.map((i: { title: string }) => i.title)).toEqual([
      "direct",
    ]);
    const du = runCli(["today", "--direct-untagged", "--json", "--db", fx.path]);
    expect(
      JSON.parse(du.stdout)
        .data.today.map((i: { title: string }) => i.title)
        .toSorted(),
    ).toEqual(["bare", "inherited"]);
  });

  it("the negations refuse the tag-presence flags and each other (exit 2)", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "x", startDate: "2026-07-02" });
    for (const argv of [
      ["today", "--untagged", "--direct-tag", "focus"],
      ["today", "--direct-untagged", "--tag", "focus"],
      ["today", "--direct-untagged", "--exact-tag"],
      ["today", "--untagged", "--direct-untagged"],
    ]) {
      expect(runCli([...argv, "--db", fx!.path]).exitCode).toBe(2);
    }
  });

  it("the echo hint reconstructs repeated + direct tag flags", () => {
    fx = buildFixtureDb();
    for (let i = 0; i < 60; i++) {
      const uuid = seedTodo(fx.db, { title: `cap ${i}`, start: "inbox", index: i });
      const t = seedTag(fx.db, `t${i}`);
      tagTask(fx.db, uuid, t);
    }
    // Two --tag refs will match nothing together, so seed one row with both.
    const foo = seedTag(fx.db, "foo");
    const bar = seedTag(fx.db, "bar");
    for (let i = 0; i < 60; i++) {
      const uuid = seedTodo(fx.db, { title: `hit ${i}`, start: "inbox", index: 100 + i });
      tagTask(fx.db, uuid, foo);
      tagTask(fx.db, uuid, bar);
    }
    const { stdout } = runCli(["inbox", "--tag", "foo", "--tag", "bar", "--db", fx.path]);
    expect(stdout).toContain("`things inbox --tag foo --tag bar --limit 100`");
  });
});

describe("cli tag filters in container views (§9a wiring)", () => {
  it("project show --tag is inheritance-inclusive; --direct-tag narrows to own tags", () => {
    fx = buildFixtureDb();
    const focus = seedTag(fx.db, "focus");
    const project = seedProject(fx.db, { title: "P" });
    tagTask(fx.db, project, focus);
    const tagged = seedTodo(fx.db, { title: "child-focus", project });
    tagTask(fx.db, tagged, focus);
    seedTodo(fx.db, { title: "child-bare", project });
    const inclusive = runCli(["project", "show", "P", "--tag", "focus", "--json", "--db", fx.path]);
    expect(
      JSON.parse(inclusive.stdout)
        .data.active.map((i: { title: string }) => i.title)
        .toSorted(),
    ).toEqual(["child-bare", "child-focus"]);
    const direct = runCli([
      "project",
      "show",
      "P",
      "--direct-tag",
      "focus",
      "--json",
      "--db",
      fx.path,
    ]);
    expect(JSON.parse(direct.stdout).data.active.map((i: { title: string }) => i.title)).toEqual([
      "child-focus",
    ]);
  });

  it("area show --direct-tag filters both row kinds; no recursion into projects", () => {
    fx = buildFixtureDb();
    const focus = seedTag(fx.db, "focus");
    const area = seedArea(fx.db, "Home");
    const loose = seedTodo(fx.db, { title: "loose-focus", area, index: 1 });
    tagTask(fx.db, loose, focus);
    seedTodo(fx.db, { title: "loose-bare", area, index: 2 });
    const projHit = seedProject(fx.db, { title: "proj-focus", area, index: 3 });
    tagTask(fx.db, projHit, focus);
    const projBare = seedProject(fx.db, { title: "proj-bare", area, index: 4 });
    const buried = seedTodo(fx.db, { title: "buried-focus", project: projBare });
    tagTask(fx.db, buried, focus);
    const json = runCli([
      "area",
      "show",
      "Home",
      "--direct-tag",
      "focus",
      "--json",
      "--db",
      fx.path,
    ]);
    const data = JSON.parse(json.stdout).data;
    expect(data.active.map((i: { title: string }) => i.title)).toEqual(["loose-focus"]);
    expect(data.projects.map((i: { title: string }) => i.title)).toEqual(["proj-focus"]);
    const all = JSON.stringify(data);
    expect(all).not.toContain("buried-focus");
  });

  it("things projects --tag filters the project list; --limit stays rejected on area show", () => {
    fx = buildFixtureDb();
    const focus = seedTag(fx.db, "focus");
    const area = seedArea(fx.db, "Zone", 1);
    const hit = seedProject(fx.db, { title: "proj-focus", area, index: 1 });
    tagTask(fx.db, hit, focus);
    seedProject(fx.db, { title: "proj-bare", area, index: 2 });
    const json = runCli(["projects", "--tag", "focus", "--json", "--db", fx.path]);
    expect(json.exitCode).toBe(0);
    const titles = JSON.parse(json.stdout).data.map((p: { title: string }) => p.title);
    expect(titles).toEqual(["proj-focus"]);
    // A content scope never grants a strict --limit on the container views.
    expect(
      runCli(["area", "show", "Zone", "--tag", "focus", "--limit", "5", "--db", fx.path]).exitCode,
    ).toBe(2);
    // The bare areas LIST rejects the tag filters (they scope an area's rows).
    expect(runCli(["areas", "--tag", "focus", "--db", fx.path]).exitCode).toBe(2);
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
    // The --all escalation is unlabeled — its effect reads from the command.
    expect(stdout).toContain("· `things inbox --all` ──");
    expect(stdout).not.toContain("all: `things inbox --all`");
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

describe("cli bounds & defaults policy (upcoming / logbook / changes)", () => {
  function seedUpcoming(count: number, dayOffset: number): void {
    for (let i = 0; i < count; i++) {
      seedTodo(fx!.db, {
        title: `sched ${dayOffset}-${i}`,
        start: "someday",
        startDate: isoFromToday(dayOffset),
        index: i,
      });
    }
  }

  it("upcoming --limit N drops the default month window — reaches a far item", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "near", start: "someday", startDate: isoFromToday(10) });
    seedTodo(fx.db, { title: "far", start: "someday", startDate: isoFromToday(45) });

    const bare = runCli(["upcoming", "--json", "--db", fx.path]).stdout;
    expect(titlesOf(bare)).toContain("near");
    expect(titlesOf(bare)).not.toContain("far"); // default 1m window excludes it
    expect(JSON.parse(bare).meta.pagination.limit).toBe(50); // default cap present

    const wide = runCli(["upcoming", "--limit", "100", "--json", "--db", fx.path]).stdout;
    expect(titlesOf(wide)).toContain("near");
    expect(titlesOf(wide)).toContain("far"); // window default lifted by explicit --limit
    expect(JSON.parse(wide).meta.pagination.limit).toBe(100);
  });

  it("upcoming --until / --since drop the default row cap (limit=null)", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "far", start: "someday", startDate: isoFromToday(45) });

    const until = runCli(["upcoming", "--until", "3m", "--json", "--db", fx.path]).stdout;
    expect(JSON.parse(until).meta.pagination.limit).toBeNull();
    expect(titlesOf(until)).toContain("far");

    const since = runCli(["upcoming", "--since", "2000", "--json", "--db", fx.path]).stdout;
    expect(JSON.parse(since).meta.pagination.limit).toBeNull();
  });

  it("upcoming --tag is a content scope — it lifts NO default (window + cap stay)", () => {
    fx = buildFixtureDb();
    const t = seedTag(fx.db, "work");
    const near = seedTodo(fx.db, { title: "near", start: "someday", startDate: isoFromToday(10) });
    const far = seedTodo(fx.db, { title: "far", start: "someday", startDate: isoFromToday(45) });
    tagTask(fx.db, near, t);
    tagTask(fx.db, far, t);
    const env = runCli(["upcoming", "--tag", "work", "--json", "--db", fx.path]).stdout;
    expect(JSON.parse(env).meta.pagination.limit).toBe(50);
    expect(titlesOf(env)).toContain("near");
    expect(titlesOf(env)).not.toContain("far"); // window default still applies under a scope
  });

  it("logbook --since drops the default row cap; bare keeps it", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, {
      title: "done",
      status: "completed",
      stopDate: new Date().getTime() / 1000,
    });
    const bare = runCli(["logbook", "--json", "--db", fx.path]).stdout;
    expect(JSON.parse(bare).meta.pagination.limit).toBe(50);
    const since = runCli(["logbook", "--since", "2000", "--json", "--db", fx.path]).stdout;
    expect(JSON.parse(since).meta.pagination.limit).toBeNull();
  });

  it("changes --since is REQUIRED, so it does NOT lift the row cap", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "recent" });
    const env = runCli(["changes", "--since", "1y", "--json", "--db", fx.path]).stdout;
    expect(JSON.parse(env).meta.pagination.limit).toBe(50);
  });

  it("hint: bare upcoming, cap biting inside the window names the window + both levers", () => {
    fx = buildFixtureDb();
    seedUpcoming(55, 12); // 55 items inside the default month window → 5 dropped
    const { stdout } = runCli(["upcoming", "--db", fx.path]);
    expect(stdout).toContain("5 more items through");
    expect(stdout).toContain("see more: `things upcoming --limit 100`");
    // The --all escalation is now unlabeled (its effect reads from the command).
    expect(stdout).toContain("· `things upcoming --all`");
    expect(stdout).not.toContain("full horizon:");
    expect(stdout).not.toContain("wider:"); // not the window-only footer
  });

  it("hint: bare upcoming, cap NOT biting offers a wider window", () => {
    fx = buildFixtureDb();
    seedUpcoming(3, 12);
    const { stdout } = runCli(["upcoming", "--db", fx.path]);
    expect(stdout).toContain("(through");
    expect(stdout).toContain("wider: `things upcoming --until 2m`");
    // --all stays unlabeled here too; the semantic `wider:` label is retained.
    expect(stdout).toContain("· `things upcoming --all`)");
    expect(stdout).not.toContain("everything:");
    expect(stdout).not.toContain("more items");
  });

  it("hint: explicit --until drops the window line and (no explicit --limit) the row hint", () => {
    fx = buildFixtureDb();
    seedUpcoming(3, 12);
    const { stdout } = runCli(["upcoming", "--until", "3m", "--db", fx.path]);
    expect(stdout).not.toContain("through");
    expect(stdout).not.toContain("more items");
  });

  it("hint: explicit --until + truncating --limit gives the row hint, but NOT --all", () => {
    fx = buildFixtureDb();
    seedUpcoming(5, 12);
    const { stdout } = runCli(["upcoming", "--until", "3m", "--limit", "2", "--db", fx.path]);
    expect(stdout).toContain("more items");
    expect(stdout).toContain("see more: `things upcoming --until 3m --limit 4`");
    expect(stdout).not.toContain("--all"); // --all conflicts with the stated window
    expect(stdout).not.toContain("through");
  });

  it("upcoming --all still rejects an explicit --since/--until (semantics unchanged)", () => {
    fx = buildFixtureDb();
    expect(runCli(["upcoming", "--all", "--since", "2w", "--db", fx.path]).exitCode).toBe(2);
    expect(runCli(["upcoming", "--all", "--until", "3m", "--db", fx.path]).exitCode).toBe(2);
  });
});

describe("cli inbox — creation-date bounds (--since/--until)", () => {
  it("--since keeps only captures created on/after the bound", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "old", start: "inbox", creationDate: epoch(40) });
    seedTodo(fx.db, { title: "recent", start: "inbox", creationDate: epoch(3) });
    const out = runCli(["inbox", "--since", "2w", "--json", "--db", fx.path]).stdout;
    expect(titlesOf(out)).toEqual(["recent"]);
  });

  it("--since is inclusive of the boundary instant (creation date, not packed)", () => {
    fx = buildFixtureDb();
    // Created exactly at local midnight on the since day — parsePeriodStart
    // lands on that same instant, and the comparison is >= (inclusive).
    const boundary = new Date(2024, 5, 1).getTime() / 1000; // 2024-06-01 00:00 local
    seedTodo(fx.db, { title: "onboundary", start: "inbox", creationDate: boundary });
    seedTodo(fx.db, { title: "before", start: "inbox", creationDate: boundary - 1 });
    const out = runCli(["inbox", "--since", "2024-06-01", "--json", "--db", fx.path]).stdout;
    expect(titlesOf(out)).toEqual(["onboundary"]);
  });

  it("--until is inclusive through the END of the named period", () => {
    fx = buildFixtureDb();
    const lastMinute = new Date(2024, 5, 1, 23, 59, 0).getTime() / 1000; // 2024-06-01 23:59
    const nextDay = new Date(2024, 5, 2, 0, 0, 1).getTime() / 1000; // 2024-06-02 00:00:01
    seedTodo(fx.db, { title: "lastminute", start: "inbox", creationDate: lastMinute });
    seedTodo(fx.db, { title: "nextday", start: "inbox", creationDate: nextDay });
    const out = runCli(["inbox", "--until", "2024-06-01", "--json", "--db", fx.path]).stdout;
    expect(titlesOf(out)).toEqual(["lastminute"]);
  });

  it("--since and --until compose as an inclusive intersection", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, {
      title: "may",
      start: "inbox",
      creationDate: new Date(2024, 4, 15).getTime() / 1000,
    });
    seedTodo(fx.db, {
      title: "jun",
      start: "inbox",
      creationDate: new Date(2024, 5, 15).getTime() / 1000,
    });
    seedTodo(fx.db, {
      title: "jul",
      start: "inbox",
      creationDate: new Date(2024, 6, 15).getTime() / 1000,
    });
    const out = runCli([
      "inbox",
      "--since",
      "2024-06-01",
      "--until",
      "2024-06-30",
      "--json",
      "--db",
      fx.path,
    ]).stdout;
    expect(titlesOf(out)).toEqual(["jun"]);
  });

  it("lift rule: explicit --since drops the default 50 row cap; bare keeps it", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "cap", start: "inbox", creationDate: epoch(1) });
    const bare = runCli(["inbox", "--json", "--db", fx.path]).stdout;
    expect(JSON.parse(bare).meta.pagination.limit).toBe(50);
    const since = runCli(["inbox", "--since", "2000", "--json", "--db", fx.path]).stdout;
    expect(JSON.parse(since).meta.pagination.limit).toBeNull();
  });

  it("lift rule: an explicit --limit composes with --since (both honored)", () => {
    fx = buildFixtureDb();
    for (let i = 0; i < 5; i++) {
      seedTodo(fx.db, { title: `c${i}`, start: "inbox", index: i, creationDate: epoch(1) });
    }
    const out = runCli([
      "inbox",
      "--since",
      "2000",
      "--limit",
      "2",
      "--json",
      "--db",
      fx.path,
    ]).stdout;
    expect(JSON.parse(out).meta.pagination.limit).toBe(2);
    expect(JSON.parse(out).data).toHaveLength(2);
  });

  it("--all semantics identical to logbook: --limit+--all conflicts, --all+--since is fine", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "x", start: "inbox", creationDate: epoch(1) });
    expect(runCli(["inbox", "--limit", "10", "--all", "--db", fx.path]).exitCode).toBe(2);
    const allSince = runCli(["inbox", "--all", "--since", "2w", "--json", "--db", fx.path]);
    expect(allSince.exitCode).toBe(0);
    expect(JSON.parse(allSince.stdout).meta.pagination.limit).toBeNull();
  });

  it("rejects an unparseable --since/--until loudly (exit 2)", () => {
    fx = buildFixtureDb();
    expect(runCli(["inbox", "--since", "not-a-date", "--db", fx.path]).exitCode).toBe(2);
    expect(runCli(["inbox", "--until", "not-a-date", "--db", fx.path]).exitCode).toBe(2);
  });

  it("footer note names the effective window in human output only, never in --json", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "recent", start: "inbox", creationDate: epoch(3) });
    const human = runCli(["inbox", "--since", "2w", "--db", fx.path]).stdout;
    expect(human).toContain("created since");
    const json = runCli(["inbox", "--since", "2w", "--json", "--db", fx.path]).stdout;
    expect(json).not.toContain("created since");
  });

  it("footer note wording covers since-only, until-only, and the both-bounds range", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, {
      title: "x",
      start: "inbox",
      creationDate: new Date(2024, 5, 15).getTime() / 1000,
    });
    expect(runCli(["inbox", "--since", "2024-06-01", "--db", fx.path]).stdout).toContain(
      "(created since Jun 1 2024)",
    );
    expect(runCli(["inbox", "--until", "2024-06-30", "--db", fx.path]).stdout).toContain(
      "(created through Jun 30 2024)",
    );
    expect(
      runCli(["inbox", "--since", "2024-06-01", "--until", "2024-06-30", "--db", fx.path]).stdout,
    ).toContain("(created Jun 1 2024 – Jun 30 2024)");
  });

  it("bare inbox appends no creation-window note", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "x", start: "inbox" });
    const human = runCli(["inbox", "--db", fx.path]).stdout;
    expect(human).not.toContain("created ");
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
      "… 4 someday to-dos inside active projects — `things someday --show-active-project-items`",
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

    // On a TTY the bare noun echoes its canonical typed form.
    expect(runTty(["Hobbies", "--db", path])).toContain("≡ things area show Hobbies");
    // Piped (default harness) it is absent.
    expect(runCli(["Hobbies", "--db", path]).stdout).not.toContain("≡ things area show");
    // A canonical TTY invocation echoes nothing.
    expect(runTty(["area", "show", "Hobbies", "--db", path])).not.toContain("≡ things");
    // --json never carries the echo line.
    expect(runCli(["Hobbies", "--json", "--db", path]).stdout).not.toContain("≡");
  });

  it("the plural collection synonyms echo their canonical singular show on a TTY", () => {
    fx = buildFixtureDb();
    const areaId = seedArea(fx.db, "Hobbies");
    const projId = seedProject(fx.db, { title: "Astro City", index: 1 });
    const path = fx.path;
    // `things areas <ref>` echoes `≡ things area show <ref>` (singular is canonical).
    expect(runTty(["areas", areaId, "--db", path])).toContain(`≡ things area show ${areaId}`);
    // The explicit `show` verb is forgiven — same echo.
    expect(runTty(["areas", "show", areaId, "--db", path])).toContain(
      `≡ things area show ${areaId}`,
    );
    // `things projects <ref>` echoes `≡ things project show <ref>`.
    expect(runTty(["projects", projId, "--db", path])).toContain(`≡ things project show ${projId}`);
    expect(runTty(["projects", "show", projId, "--db", path])).toContain(
      `≡ things project show ${projId}`,
    );
    // The bare plural list form echoes nothing.
    expect(runTty(["areas", "--db", path])).not.toContain("≡ things");
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

  it("--show-logged: shown-of-total header, drill footer with the real area ref", () => {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "Old Stuff");
    for (let i = 0; i < 3; i++) {
      seedTodo(fx.db, {
        title: `done ${i}`,
        area,
        status: "completed",
        stopDate: 1_500_000_000 + i,
      });
    }
    // Truncated: count stays in the header, the drill rides the footer.
    const cut = runCli(["area", "show", "Old Stuff", "--show-logged", "2", "--db", fx.path]).stdout;
    expect(cut).toContain("── Logged (2 of 3) ──");
    expect(cut).toContain("… 1 more — `things logbook --area 'Old Stuff'`");
    // Complete: plain count like Trashed, no footer.
    const all = runCli(["area", "show", "Old Stuff", "--show-logged", "9", "--db", fx.path]).stdout;
    expect(all).toContain("── Logged (3) ──");
    expect(all).not.toContain("more — `things logbook");
    // Collapsed (toggle off): the hidden-section placeholder echoes the recent
    // --show-logged reveal (labeled: it shows only 15) AND the full logbook drill.
    const off = runCli(["area", "show", "Old Stuff", "--db", fx.path]).stdout;
    expect(off).toContain(
      `… 3 logged items — recent: \`things area show "Old Stuff" --show-logged\` · \`things logbook --area 'Old Stuff'\``,
    );
  });

  it("disclosure hints: truncation footer indents two spaces; hidden-section placeholders stand flush (plural counts)", () => {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "Mixed Bag");
    for (let i = 0; i < 3; i++) seedTodo(fx.db, { title: `active ${i}`, area, index: i });
    for (let i = 0; i < 2; i++)
      seedTodo(fx.db, { title: `later ${i}`, area, start: "someday", index: 10 + i });
    const lines = runCli([
      "area",
      "show",
      "Mixed Bag",
      "--area-limit",
      "1",
      "--db",
      fx.path,
    ]).stdout.split("\n");
    // TRUNCATION FOOTER — its block is partially shown above, so it is indented
    // two spaces; the command doubles the cap that hit.
    expect(lines).toContain(`  … 2 more to-dos — \`things area show "Mixed Bag" --area-limit 2\``);
    // HIDDEN-SECTION PLACEHOLDER — the whole later section is unrendered, so it
    // is flush at the position that section would occupy, with the full command.
    expect(lines).toContain(`… 2 later items — \`things area show "Mixed Bag" --show-later\``);
  });

  it("disclosure hints: hidden-section commands preserve the user's show-toggle flags (singular count)", () => {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "Kept Flags");
    seedTodo(fx.db, { title: "active", area, index: 0 });
    seedTodo(fx.db, { title: "later", area, start: "someday", index: 1 });
    // `--show-logged 5` reveals the logged section, so the still-hidden later
    // placeholder must echo the invocation WITH that flag, then add --show-later.
    const lines = runCli([
      "area",
      "show",
      "Kept Flags",
      "--show-logged",
      "5",
      "--db",
      fx.path,
    ]).stdout.split("\n");
    expect(lines).toContain(
      `… 1 later item — \`things area show "Kept Flags" --show-logged 5 --show-later\``,
    );
  });

  it("disclosure hints: project show hidden placeholders echo full commands (unlabeled --show-logged)", () => {
    fx = buildFixtureDb();
    const proj = seedProject(fx.db, { title: "Roadmap" });
    seedTodo(fx.db, { title: "active", project: proj, index: 0 });
    seedTodo(fx.db, { title: "someday", project: proj, start: "someday", index: 1 });
    seedTodo(fx.db, { title: "done", project: proj, status: "completed", stopDate: 1_500_000_000 });
    const lines = runCli(["project", "show", "Roadmap", "--db", fx.path]).stdout.split("\n");
    expect(lines).toContain("… 1 later item — `things project show Roadmap --show-later`");
    // A project logbook is finite, so bare --show-logged is the FULL history —
    // the command reads its own effect and takes no `recent:` label.
    expect(lines).toContain("… 1 logged item — `things project show Roadmap --show-logged`");
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

describe("cli doctor sync-health (fixture db, real environment path)", () => {
  it("--json carries syncHealth; empty BSSyncronyMetadata takes the no-account path without crashing", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "anything" });
    const { stdout, exitCode } = runCli(["doctor", "--json", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.kind).toBe("doctor");
    const sh = envelope.data.syncHealth;
    expect(sh).toBeTruthy();
    expect(typeof sh.appRunning.running).toBe("boolean");
    // The pristine fixture DB has the table with zero rows → no attached account.
    expect(sh.cloud.accountAttached).toBe(false);
    expect(sh.cloud.lastSyncAttempt).toBeNull();
  });

  it("human output renders a Sync health section", () => {
    fx = buildFixtureDb();
    const { stdout, exitCode } = runCli(["doctor", "--db", fx.path]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("── Sync health ──");
    expect(stdout).toContain("cloud:");
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

describe("cli tags listing (indented tree)", () => {
  it("renders an indented tree — leaf names only, 2 spaces per depth, no uuid, DFS order", () => {
    fx = buildFixtureDb();
    // A 3-deep chain plus a sibling root, to exercise depth and DFS ordering.
    const root = seedTag(fx.db, "old labels");
    const mid = seedTag(fx.db, "areas", root);
    seedTag(fx.db, "mental", mid);
    seedTag(fx.db, "recurring"); // sibling root, later index
    const { stdout, exitCode } = runCli(["tags", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const lines = stdout.trimEnd().split("\n");
    // Root at column 0; child indented 2; grandchild indented 4 — each LEAF name
    // present WITHOUT any ancestor prefix; DFS order preserved; a plain root last.
    expect(lines).toEqual(["old labels", "  areas", "    mental", "recurring"]);
    // No uuid anywhere in the human output.
    expect(stdout).not.toContain("tag-");
  });

  it("--json carries the parent NAME per tag (null for roots), no uuid", () => {
    fx = buildFixtureDb();
    const root = seedTag(fx.db, "old labels");
    seedTag(fx.db, "areas", root);
    const { stdout, exitCode } = runCli(["tags", "--json", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout).data as { title: string; parent?: string | null }[];
    // Omit-empty (contracts.md): a root tag has NO parent key (absent = root);
    // a nested tag carries its parent NAME.
    const rootTag = data.find((t) => t.title === "old labels");
    expect(rootTag).toBeDefined();
    expect("parent" in (rootTag ?? {})).toBe(false);
    expect(data.find((t) => t.title === "areas")?.parent).toBe("old labels");
    // Zero surfaced tag-uuid sites: no object carries a uuid key.
    expect(data.every((t) => !("uuid" in t))).toBe(true);
    expect(stdout).not.toContain("tag-");
  });
});

describe("--json error-path universality", () => {
  it("ambiguous project write target → JSON envelope, code=ambiguous, machine candidates", async () => {
    fx = buildFixtureDb();
    seedProject(fx.db, { title: "Dup" });
    seedProject(fx.db, { title: "Dup" });
    const { stdout, exitCode } = await runCliAsync([
      "project",
      "update",
      "Dup",
      "--title",
      "x",
      "--json",
      "--db",
      fx.path,
    ]);
    expect(exitCode).toBe(2);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("ambiguous");
    expect(env.error.details.candidates).toHaveLength(2);
    expect(env.error.details.candidates[0]).toHaveProperty("uuid");
    expect(env.error.details.candidates[0]).toHaveProperty("title", "Dup");
  });

  it("not-found project write target → JSON envelope, code=not-found", async () => {
    fx = buildFixtureDb();
    const { stdout, exitCode } = await runCliAsync([
      "project",
      "update",
      "ghost",
      "--title",
      "x",
      "--json",
      "--db",
      fx.path,
    ]);
    expect(exitCode).toBe(2);
    const env = JSON.parse(stdout);
    expect(env.error.code).toBe("not-found");
    expect(env.error.details.candidates).toEqual([]);
  });

  it("flag-combination usage error honors --json (envelope on stdout, not prose on stderr)", () => {
    fx = buildFixtureDb();
    const { stdout, exitCode } = runCli(["project", "move", "whatever", "--json", "--db", fx.path]);
    expect(exitCode).toBe(2);
    const env = JSON.parse(stdout);
    expect(env.error.code).toBe("usage");
    expect(env.error.message).toContain("--area");
  });

  it("bad --limit honors --json (usage envelope)", () => {
    fx = buildFixtureDb();
    const { stdout, exitCode } = runCli(["inbox", "--limit", "0", "--json", "--db", fx.path]);
    expect(exitCode).toBe(2);
    const env = JSON.parse(stdout);
    expect(env.error.code).toBe("usage");
    expect(env.error.message).toContain("--limit");
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

/** Run the CLI in-process, capturing BOTH stdout and stderr (did-you-mean writes to stderr). */
function runCliErr(argv: string[]): { stdout: string; stderr: string; exitCode: number } {
  const out: string[] = [];
  const err: string[] = [];
  const ow = process.stdout.write.bind(process.stdout);
  const ew = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => {
    out.push(typeof c === "string" ? c : new TextDecoder().decode(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    err.push(typeof c === "string" ? c : new TextDecoder().decode(c));
    return true;
  }) as typeof process.stderr.write;
  const oc = process.exitCode;
  try {
    const program = buildProgram();
    program.exitOverride();
    try {
      program.parse(resolveInvocation(program, argv).argv, { from: "user" });
    } catch {
      // commander exitOverride throws on usage errors — captured via exitCode
    }
    return { stdout: out.join(""), stderr: err.join(""), exitCode: Number(process.exitCode ?? 0) };
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
    process.exitCode = oc;
  }
}

describe("cli namespace implied-show (item 2)", () => {
  it("`things area <name>` omits the show verb and renders the area card", () => {
    fx = buildFixtureDb();
    seedArea(fx.db, "Hobbies");
    const out = runCli(["area", "hobbies", "--db", fx.path]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("Area: ⬡ Hobbies");
  });

  it("registered verbs still win (reserved-word rule)", () => {
    fx = buildFixtureDb();
    seedArea(fx.db, "Hobbies");
    // `area show Hobbies` is canonical; a real subcommand is untouched.
    const shown = runCli(["area", "show", "Hobbies", "--json", "--db", fx.path]);
    expect(JSON.parse(shown.stdout).kind).toBe("area-view");
  });

  it("the TYPE constrains resolution — `things area <project-uuid>` errors loudly", () => {
    fx = buildFixtureDb();
    const proj = seedProject(fx.db, { title: "Firmware", index: 1 });
    const out = runCliErr(["area", proj, "--db", fx.path]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("no area matching");
  });

  it("meta.resolvedCommand + normalized echo ride along like other sugar", () => {
    fx = buildFixtureDb();
    seedArea(fx.db, "Hobbies");
    const env = JSON.parse(runCli(["area", "hobbies", "--json", "--db", fx.path]).stdout);
    expect(env.meta.resolvedCommand).toBe("things area show hobbies");
    // trailing flags pass through
    expect(runCli(["area", "hobbies", "--show-later", "--json", "--db", fx.path]).exitCode).toBe(0);
  });
});

describe("cli did-you-mean fallback (item 4)", () => {
  function seedWorld(): void {
    fx = buildFixtureDb();
    seedArea(fx!.db, "Hobbies");
    seedProject(fx!.db, { title: "OutRun Restoration", index: 1 });
    seedProject(fx!.db, { title: "OutRun Wiring", index: 2 });
    seedTodo(fx!.db, { title: "Read Thread on Astro City Restoration" });
  }

  it("an unresolved bare noun exits 2 with candidates and a search suggestion (human)", () => {
    seedWorld();
    const out = runCliErr(["outru", "--db", fx!.path]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('no command or item named "outru"');
    expect(out.stderr).toContain("did you mean:");
    expect(out.stderr).toContain("OutRun Restoration");
    expect(out.stderr).toContain("or try: `things search 'outru'`");
  });

  it("--json carries error.details.candidates (standard item shapes), exit 2", () => {
    seedWorld();
    const out = runCli(["outru", "--json", "--db", fx!.path]);
    expect(out.exitCode).toBe(2);
    const env = JSON.parse(out.stdout);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("not-found");
    const titles = env.error.details.candidates.map((c: { title: string }) => c.title);
    expect(titles).toEqual(expect.arrayContaining(["OutRun Restoration", "OutRun Wiring"]));
  });

  it("caps the candidate list at ~10 and reports `… n more`", () => {
    fx = buildFixtureDb();
    for (let i = 0; i < 15; i++) seedTodo(fx!.db, { title: `match ${i}`, index: i });
    // Bare `match` has no exact name, so it fails resolution; did-you-mean then
    // lists the 15 title-substring matches, capped at 10.
    const json = runCli(["match", "--json", "--db", fx!.path]);
    expect(json.exitCode).toBe(2);
    const env = JSON.parse(json.stdout);
    expect(env.ok).toBe(false);
    expect(env.error.details.candidates).toHaveLength(10);
    const human = runCliErr(["match", "--db", fx!.path]);
    expect(human.exitCode).toBe(2);
    expect(human.stderr).toContain("5 more — `things search 'match'`");
  });

  it("empty lite-search = plain error + suggestion, no candidate block", () => {
    seedWorld();
    const out = runCliErr(["zzzznope", "--db", fx!.path]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).not.toContain("did you mean:");
    expect(out.stderr).toContain("or try:");
  });

  it("TYPED scoping: namespace/explicit paths list only that type", () => {
    seedWorld();
    // `things project <miss>` (namespace implied-show) → projects only.
    const nsProj = JSON.parse(runCli(["project", "outru", "--json", "--db", fx!.path]).stdout);
    expect(
      nsProj.error.details.candidates.every((c: { type?: string }) => c.type === "project"),
    ).toBe(true);
    // explicit `things project show <miss>` → projects only.
    const typedProj = JSON.parse(
      runCli(["project", "show", "outru", "--json", "--db", fx!.path]).stdout,
    );
    expect(typedProj.error.details.candidates.length).toBeGreaterThan(0);
    // `things area <miss>` → areas only (OutRun projects excluded).
    const nsArea = JSON.parse(runCli(["area", "outru", "--json", "--db", fx!.path]).stdout);
    expect(nsArea.error.details.candidates).toHaveLength(0);
    // untyped bare noun keeps the mixed list.
    const untyped = JSON.parse(runCli(["outru", "--json", "--db", fx!.path]).stdout);
    expect(untyped.error.details.candidates.length).toBeGreaterThan(0);
  });

  it("a to-do TITLE never resolves on the sugar path (reachable only via uuid/did-you-mean)", () => {
    seedWorld();
    const out = runCliErr(["Read Thread on Astro City Restoration", "--db", fx!.path]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("no command or item named");
    // …but it DOES appear in the untyped candidate list (with its uuid).
    const env = JSON.parse(
      runCli(["Read Thread on Astro City Restoration", "--json", "--db", fx!.path]).stdout,
    );
    expect(env.error.details.candidates.map((c: { title: string }) => c.title)).toContain(
      "Read Thread on Astro City Restoration",
    );
  });
});

describe("cli sugar routing tiers (refinements B/C)", () => {
  it("dash + case normalization resolves quote-free: `restore-astro-city-cabinet`", () => {
    fx = buildFixtureDb();
    seedProject(fx.db, { title: "Restore Astro City Cabinet", index: 1 });
    const out = runCli(["restore-astro-city-cabinet", "--db", fx.path]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("Restore Astro City Cabinet");
  });

  it("the uuid-PREFIX tier is dropped on the sugar path but kept for typed commands", () => {
    fx = buildFixtureDb();
    // Base62 area uuid so a prefix could match the dropped tier.
    fx.db
      .prepare(`INSERT INTO TMArea (uuid, title, visible, "index") VALUES (?, ?, 1, 0)`)
      .run("AbCdEf123456", "Zone");
    // Bare-noun with a 6-char PREFIX: no longer resolves (did-you-mean, exit 2).
    expect(runCliErr(["AbCdEf", "--db", fx.path]).exitCode).toBe(2);
    // The FULL uuid still resolves via the exact-uuid tier.
    expect(runCli(["AbCdEf123456", "--json", "--db", fx.path]).exitCode).toBe(0);
    // The typed command keeps the historical prefix tier.
    const typed = runCli(["area", "show", "AbCdEf", "--json", "--db", fx.path]);
    expect(typed.exitCode).toBe(0);
    expect(JSON.parse(typed.stdout).data.area.title).toBe("Zone");
  });
});

describe("cli search heading doctrine + ranking (item 5)", () => {
  it("a heading-title match surfaces the parent project, annotated `via heading`", () => {
    fx = buildFixtureDb();
    const proj = seedProject(fx.db, { title: "Arcade Restoration", index: 1 });
    seedHeading(fx.db, { title: "Fix OutRun Steering Wheel", project: proj });
    const human = runCli(["search", "OutRun", "--db", fx.path]);
    expect(human.stdout).toContain("Arcade Restoration");
    expect(human.stdout).toContain('(via heading "Fix OutRun Steering Wheel")');
    const env = JSON.parse(runCli(["search", "OutRun", "--json", "--db", fx.path]).stdout);
    expect(env.data).toHaveLength(1);
    expect(env.data[0].type).toBe("project");
    expect(env.data[0].matchedVia).toEqual({ kind: "heading", title: "Fix OutRun Steering Wheel" });
  });

  it("ranks title > notes and projects above to-dos (before the cap)", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "note only", notes: "widget", modificationDate: 1_790_000_000 });
    seedTodo(fx.db, { title: "widget todo", modificationDate: 1_700_000_000 });
    seedProject(fx.db, { title: "widget project", modificationDate: 1_700_000_000, index: 1 });
    const env = JSON.parse(runCli(["search", "widget", "--json", "--db", fx.path]).stdout);
    expect(env.data.map((i: { title: string }) => i.title)).toEqual([
      "widget project",
      "widget todo",
      "note only",
    ]);
  });
});

describe("overdue filter (cli)", () => {
  it("today --overdue narrows to open, past-deadline members", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "past", start: "active", deadline: isoFromToday(-1) });
    seedTodo(fx.db, { title: "due-today", start: "active", deadline: isoFromToday(0) });
    seedTodo(fx.db, { title: "future", start: "active", deadline: isoFromToday(3) });
    const env = JSON.parse(runCli(["today", "--overdue", "--json", "--db", fx.path]).stdout);
    expect(env.data.today.map((i: { title: string }) => i.title)).toEqual(["past"]);
  });

  it("is a content scope: it never lifts the default row cap", () => {
    fx = buildFixtureDb();
    // 55 overdue inbox captures > the default 50: a content scope must not lift
    // the cap the way a range bound (--since/--until) would.
    for (let i = 0; i < 55; i++) {
      seedTodo(fx.db, {
        title: `cap ${i}`,
        start: "inbox",
        deadline: isoFromToday(-1),
        index: i,
      });
    }
    const capped = JSON.parse(runCli(["inbox", "--overdue", "--json", "--db", fx.path]).stdout);
    expect(capped.data).toHaveLength(50);
    // --all (a volume lift) still reveals them all — overdue composes with it.
    const all = JSON.parse(
      runCli(["inbox", "--overdue", "--all", "--json", "--db", fx.path]).stdout,
    );
    expect(all.data).toHaveLength(55);
  });

  it("search --overdue refuses the status-widening flags", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "widget", start: "active", deadline: isoFromToday(-1) });
    for (const flag of ["--logged", "--trashed", "--all"]) {
      const { exitCode } = runCli(["search", "widget", "--overdue", flag, "--db", fx.path]);
      expect(exitCode, flag).toBe(2);
    }
    // On its own it is accepted and narrows the needle.
    const ok = runCli(["search", "widget", "--overdue", "--json", "--db", fx.path]);
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(ok.stdout).data.map((i: { title: string }) => i.title)).toEqual(["widget"]);
  });
});

describe("overdue in container views (cli)", () => {
  it("projects --overdue keeps only projects whose own deadline is past", () => {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "Zone", 1);
    seedProject(fx.db, { title: "proj-overdue", area, deadline: isoFromToday(-1), index: 1 });
    seedProject(fx.db, { title: "proj-due", area, deadline: isoFromToday(0), index: 2 });
    seedProject(fx.db, { title: "proj-future", area, deadline: isoFromToday(5), index: 3 });
    seedProject(fx.db, { title: "proj-none", area, index: 4 });
    const env = JSON.parse(runCli(["projects", "--overdue", "--json", "--db", fx.path]).stdout);
    // due-today is NOT overdue (strict <); no-deadline and future drop too.
    expect(env.data.map((p: { title: string }) => p.title)).toEqual(["proj-overdue"]);
  });

  it("project show --overdue filters children and collapses empty headings", () => {
    fx = buildFixtureDb();
    const proj = seedProject(fx.db, { title: "Launch", index: 1 });
    const hHit = seedHeading(fx.db, { title: "Phase 1", project: proj, index: 1 });
    seedHeading(fx.db, { title: "Phase 2", project: proj, index: 2 });
    seedTodo(fx.db, {
      title: "loose-overdue",
      project: proj,
      deadline: isoFromToday(-1),
      index: 1,
    });
    seedTodo(fx.db, { title: "loose-due", project: proj, deadline: isoFromToday(0), index: 2 });
    seedTodo(fx.db, {
      title: "p1-overdue",
      heading: hHit,
      project: null,
      deadline: isoFromToday(-2),
    });
    const env = JSON.parse(
      runCli(["project", "show", "Launch", "--overdue", "--json", "--db", fx.path]).stdout,
    );
    expect(env.data.project.title).toBe("Launch");
    expect(env.data.active.map((i: { title: string }) => i.title)).toEqual(["loose-overdue"]);
    // Phase 2 collapsed (no surviving child); Phase 1 kept.
    expect(env.data.headings).toHaveLength(1);
    expect(env.data.headings[0].heading.title).toBe("Phase 1");
    // The TTY render omits the collapsed heading entirely.
    const tty = runCli(["project", "show", "Launch", "--overdue", "--db", fx.path]).stdout;
    expect(tty).toContain("Phase 1");
    expect(tty).not.toContain("Phase 2");
  });

  it("area show --overdue filters loose to-dos AND projects; no recursion into project contents", () => {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "Home");
    seedTodo(fx.db, { title: "todo-overdue", area, deadline: isoFromToday(-1), index: 1 });
    seedTodo(fx.db, { title: "todo-due", area, deadline: isoFromToday(0), index: 2 });
    const projOverdue = seedProject(fx.db, {
      title: "proj-overdue",
      area,
      deadline: isoFromToday(-3),
      index: 3,
    });
    const projClean = seedProject(fx.db, { title: "proj-clean", area, index: 4 });
    // Buried overdue to-do inside the non-overdue project must NOT surface.
    seedTodo(fx.db, { title: "buried-overdue", project: projClean, deadline: isoFromToday(-5) });
    seedTodo(fx.db, { title: "buried-clean", project: projOverdue });
    const env = JSON.parse(
      runCli(["area", "show", "Home", "--overdue", "--json", "--db", fx.path]).stdout,
    );
    expect(env.data.active.map((i: { title: string }) => i.title)).toEqual(["todo-overdue"]);
    expect(env.data.projects.map((i: { title: string }) => i.title)).toEqual(["proj-overdue"]);
    const tty = runCli(["area", "show", "Home", "--overdue", "--db", fx.path]).stdout;
    expect(tty).not.toContain("buried-overdue");
    expect(tty).not.toContain("proj-clean");
  });

  it("areas LIST rejects --overdue (areas have no deadline)", () => {
    fx = buildFixtureDb();
    seedArea(fx.db, "Home");
    expect(runCli(["areas", "--overdue", "--db", fx.path]).exitCode).toBe(2);
    // But `areas <ref> --overdue` IS area show and is accepted.
    seedTodo(fx.db, { title: "od", area: seedArea(fx.db, "Work"), deadline: isoFromToday(-1) });
    expect(runCli(["areas", "Work", "--overdue", "--db", fx.path]).exitCode).toBe(0);
  });

  it("--overdue never lifts the container no-strict-limit doctrine", () => {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "Home");
    seedTodo(fx.db, { title: "od", area, deadline: isoFromToday(-1) });
    // area show forbids a strict --limit whether or not --overdue is present.
    expect(
      runCli(["area", "show", "Home", "--overdue", "--limit", "5", "--db", fx.path]).exitCode,
    ).toBe(2);
    // project show has no --limit at all — unknown option even with --overdue.
    const proj = seedProject(fx.db, { title: "P" });
    seedTodo(fx.db, { title: "c", project: proj, deadline: isoFromToday(-1) });
    expect(() =>
      runCli(["project", "show", "P", "--overdue", "--limit", "5", "--db", fx!.path]),
    ).toThrow();
  });
});
