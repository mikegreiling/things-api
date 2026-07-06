import { afterEach, describe, expect, it } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { localToday } from "../../src/model/dates.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTag, seedTodo, tagTask } from "../fixtures/seed.ts";

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
