/**
 * Help text is the agent API contract (design §3): agents discover the tool
 * through --help, so its load-bearing statements — behavior, side effects,
 * confirmation flag names, exit codes — are regression-tested here. These
 * assert the CONTRACT lines, not the full rendering, so cosmetic rewording
 * stays cheap while contract drift fails loudly. A companion suite enforces
 * the consumer-voice rules of docs/design/surface-copy.md.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { Command } from "commander";

import { buildProgram } from "../../src/cli/main.ts";
import {
  HELP_GROUPS,
  INDEX,
  renderTopic,
  renderTopLevelHelp,
  TOPIC_NAMES,
} from "../../src/cli/help.ts";
import { resolveInvocation } from "../../src/cli/resolve-invocation.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTodo } from "../fixtures/seed.ts";

/** Run the CLI in-process through the real resolver, capturing stdout + exit. */
function runCli(argv: string[]): { stdout: string; stderr: string; exitCode: number } {
  const out: string[] = [];
  const err: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const originalExit = process.exitCode;
  const originalProcessExit = process.exit;
  process.stdout.write = ((c: string | Uint8Array) => {
    out.push(typeof c === "string" ? c : new TextDecoder().decode(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    err.push(typeof c === "string" ? c : new TextDecoder().decode(c));
    return true;
  }) as typeof process.stderr.write;
  // Some error paths (an unknown subcommand of a group) reach process.exit
  // directly rather than commander's exitOverride throw — capture both.
  let procExit: number | null = null;
  process.exit = ((code?: number) => {
    procExit = Number(code ?? 0);
    throw Object.assign(new Error("exit-signal"), { exitSignal: true });
  }) as typeof process.exit;
  try {
    const program = buildProgram();
    program.exitOverride();
    let thrownExit: number | null = null;
    try {
      program.parse(resolveInvocation(program, argv).argv, { from: "user" });
    } catch (e) {
      if ((e as { exitSignal?: boolean }).exitSignal !== true) {
        // A commander error/help exit throws a CommanderError carrying exitCode.
        const ec = (e as { exitCode?: unknown }).exitCode;
        if (typeof ec === "number") thrownExit = ec;
      }
    }
    const exitCode =
      procExit ?? thrownExit ?? (process.exitCode !== undefined ? Number(process.exitCode) : 0);
    return { stdout: out.join(""), stderr: err.join(""), exitCode };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    process.exit = originalProcessExit;
    process.exitCode = originalExit;
  }
}

let fx: FixtureDb | null = null;
afterEach(() => {
  fx?.close();
  fx = null;
});

function helpFor(...path: string[]): string {
  const program = buildProgram();
  let cmd = program as ReturnType<typeof buildProgram>;
  for (const name of path) {
    const next = cmd.commands.find((c) => c.name() === name);
    if (next === undefined) throw new Error(`no command: ${path.join(" ")}`);
    cmd = next;
  }
  // Commander wraps to terminal width; collapse whitespace so contract
  // substrings match regardless of where lines break.
  return cmd.helpInformation().replace(/\s+/g, " ");
}

// The pointer is an addHelpText(after) epilog, emitted on render (outputHelp)
// rather than in helpInformation() — capture the rendered form.
const renderedHelp = (name: string): string => {
  const program = buildProgram();
  const cmd = program.commands.find((c) => c.name() === name);
  if (cmd === undefined) throw new Error(`no command: ${name}`);
  let out = "";
  cmd.configureOutput({ writeOut: (s) => void (out += s) });
  cmd.outputHelp();
  return out;
};

function allHelp(cmd: Command, path: string[]): [string, string][] {
  const own: [string, string][] = [
    [path.join(" ") || "(root)", cmd.helpInformation().replace(/\s+/g, " ")],
  ];
  return [...own, ...cmd.commands.flatMap((c) => allHelp(c, [...path, c.name()]))];
}

describe("top-level index (the signpost)", () => {
  it("fits the line budget: <= 65 output lines at width 100", () => {
    const program = buildProgram();
    const lines = renderTopLevelHelp(program, 100).split("\n");
    expect(lines.length).toBeLessThanOrEqual(65);
  });

  it("stays within budget across common widths (no wrap blowout)", () => {
    const program = buildProgram();
    for (const width of [70, 80, 100, 120]) {
      const n = renderTopLevelHelp(program, width).split("\n").length;
      expect(n, `width ${width}`).toBeLessThanOrEqual(65);
    }
  });

  it("is a signpost, not a wall: AGENT NOTES and per-command paragraphs are gone", () => {
    const program = buildProgram();
    const flat = renderTopLevelHelp(program, 100).replace(/\s+/g, " ");
    // The former epilog and long descriptions moved to `things help <topic>`
    // and per-command --help respectively.
    expect(flat).not.toContain("AGENT NOTES");
    expect(flat).not.toContain("versioned envelope on stdout, logs on stderr");
    // It DOES point onward.
    expect(flat).toContain("things <command> --help");
    expect(flat).toContain("things help");
    for (const g of HELP_GROUPS) expect(flat).toContain(g.title);
  });

  it("indexes every registered top-level command exactly once", () => {
    const program = buildProgram();
    const registered = program.commands.map((c) => c.name()).filter((n) => n !== "help");
    const grouped = HELP_GROUPS.flatMap((g) => g.commands);
    // Exactly once across all groups.
    for (const name of grouped) {
      expect(
        grouped.filter((n) => n === name),
        name,
      ).toHaveLength(1);
    }
    // Every registered command is grouped and has index copy…
    for (const name of registered) {
      expect(grouped, `"${name}" must be grouped`).toContain(name);
      expect(INDEX[name], `"${name}" needs index copy`).toBeDefined();
    }
    // …and nothing is grouped or described that is not a real command.
    for (const name of grouped) {
      expect(registered, `"${name}" grouped but not registered`).toContain(name);
    }
    expect(Object.keys(INDEX).toSorted()).toEqual([...registered].toSorted());
  });

  it("index descriptors are one behavioral line each, <= 58 chars", () => {
    for (const [name, entry] of Object.entries(INDEX)) {
      expect(entry.desc.includes("\n"), `${name} desc is one line`).toBe(false);
      expect(entry.desc.length, `${name} desc <= 58`).toBeLessThanOrEqual(58);
    }
  });

  it("global options are condensed to one line each", () => {
    const program = buildProgram();
    const lines = renderTopLevelHelp(program, 100).split("\n");
    const start = lines.findIndex((l) => l.startsWith("Global options"));
    expect(start).toBeGreaterThan(-1);
    // Every option line until the following blank is a single option row.
    const optionLines: string[] = [];
    for (let i = start + 1; i < lines.length && lines[i] !== ""; i++) {
      optionLines.push(lines[i] as string);
    }
    expect(optionLines.length).toBeGreaterThanOrEqual(2);
    for (const l of optionLines) {
      expect(l.trimStart().startsWith("-"), `option row: ${l}`).toBe(true);
      // One physical line, one option — its descriptor never spilled onto a
      // second line (the row still fits at width 100).
      expect(l.length).toBeLessThanOrEqual(100);
    }
    const joined = optionLines.join(" ");
    expect(joined).toContain("--json");
    expect(joined).toContain("--db");
  });

  it("the wired --help path renders the index (not commander's default)", () => {
    const { stdout } = runCli(["--help"]);
    const flat = stdout.replace(/\s+/g, " ");
    expect(flat).toContain("Views");
    expect(flat).toContain("Browse & search");
    expect(flat).not.toContain("AGENT NOTES");
  });
});

describe("help topics", () => {
  it("every topic renders and stays <= 40 lines (at width 100)", () => {
    for (const name of TOPIC_NAMES) {
      const body = renderTopic(name, 100);
      expect(body, name).not.toBeNull();
      expect((body as string).split("\n").length, name).toBeLessThanOrEqual(40);
    }
  });

  it("agent topic carries the former AGENT NOTES contract lines", () => {
    const body = (renderTopic("agent", 100) as string).replace(/\s+/g, " ");
    expect(body).toContain(
      "0 ok, 2 usage, 3 verify-failed, 4 blocked, 5 drift-blocked, 6 unsupported, 7 environment",
    );
    expect(body).toContain("No command ever prompts interactively");
    expect(body).toContain("things legend");
    expect(body).toContain("--dry-run");
  });

  it("filters/ids/output/writes topics carry their load-bearing lines", () => {
    const filters = (renderTopic("filters", 100) as string).replace(/\s+/g, " ");
    expect(filters).toContain("--tag");
    expect(filters).toContain("--untagged");
    expect(filters).toContain("--limit");
    expect(filters).toContain("--since");
    expect(filters).toContain("--all");
    const ids = (renderTopic("ids", 100) as string).replace(/\s+/g, " ");
    expect(ids).toContain("PREFIX");
    expect(ids).toContain("share link");
    expect(ids.toLowerCase()).toContain("command names always win");
    const output = (renderTopic("output", 100) as string).replace(/\s+/g, " ");
    expect(output).toContain("--json");
    expect(output).toContain("THINGS_WIDTH");
    const writes = (renderTopic("writes", 100) as string).replace(/\s+/g, " ");
    expect(writes).toContain("--dry-run");
    expect(writes).toContain("--dangerously-permanent");
    expect(writes).toContain("things undo");
    expect(writes).toContain("things capabilities");
  });

  it("unknown topic returns null (renderer) and the command lists topics", () => {
    expect(renderTopic("bogus", 100)).toBeNull();
    const { stderr, exitCode } = runCli(["help", "bogus"]);
    expect(exitCode).toBe(2);
    for (const name of TOPIC_NAMES) expect(stderr).toContain(name);
  });

  it("`things help <command>` still defers to that command's own --help", () => {
    const { stdout } = runCli(["help", "todo", "add"]);
    expect(stdout).toContain("Create a to-do");
  });
});

describe("plural list views accept a ref (true synonym of show, with the canonical echo)", () => {
  it("`things areas <ref>` shows one area — same body as `area show`, echoing the singular", () => {
    fx = buildFixtureDb();
    const areaId = seedArea(fx.db, "Hobbies");
    seedTodo(fx.db, { title: "loose in area", area: areaId });
    const plural = runCli(["areas", areaId, "--db", fx.path, "--json"]);
    const singular = runCli(["area", "show", areaId, "--db", fx.path, "--json"]);
    expect(plural.exitCode).toBe(0);
    // The rendered BODY is byte-identical (a true synonym, not a reimplementation).
    expect(JSON.parse(plural.stdout).data).toEqual(JSON.parse(singular.stdout).data);
    // The plural form echoes the canonical SINGULAR command; the singular is
    // already canonical and echoes nothing.
    expect(JSON.parse(plural.stdout).meta.resolvedCommand).toBe(`things area show ${areaId}`);
    expect(JSON.parse(singular.stdout).meta.resolvedCommand).toBeUndefined();
    // An explicit `show` verb is forgiven and routes identically.
    const verb = runCli(["areas", "show", areaId, "--db", fx.path, "--json"]);
    expect(verb.exitCode).toBe(0);
    expect(JSON.parse(verb.stdout).data).toEqual(JSON.parse(singular.stdout).data);
    expect(JSON.parse(verb.stdout).meta.resolvedCommand).toBe(`things area show ${areaId}`);
    // Bare plural still lists — echo-free.
    const list = runCli(["areas", "--db", fx.path, "--json"]);
    expect(JSON.parse(list.stdout).kind).toBe("areas");
    expect(JSON.parse(list.stdout).meta.resolvedCommand).toBeUndefined();
  });

  it("`things projects <ref>` shows one project — same body as `project show`, echoing the singular", () => {
    fx = buildFixtureDb();
    const areaId = seedArea(fx.db, "Hobbies");
    const projId = seedProject(fx.db, { title: "Astro City", area: areaId });
    seedTodo(fx.db, { title: "sand it", project: projId });
    const plural = runCli(["projects", projId, "--db", fx.path, "--json"]);
    const singular = runCli(["project", "show", projId, "--db", fx.path, "--json"]);
    expect(plural.exitCode).toBe(0);
    expect(JSON.parse(plural.stdout).data).toEqual(JSON.parse(singular.stdout).data);
    expect(JSON.parse(plural.stdout).meta.resolvedCommand).toBe(`things project show ${projId}`);
    expect(JSON.parse(singular.stdout).meta.resolvedCommand).toBeUndefined();
    const verb = runCli(["projects", "show", projId, "--db", fx.path, "--json"]);
    expect(verb.exitCode).toBe(0);
    expect(JSON.parse(verb.stdout).data).toEqual(JSON.parse(singular.stdout).data);
    expect(JSON.parse(verb.stdout).meta.resolvedCommand).toBe(`things project show ${projId}`);
    const list = runCli(["projects", "--db", fx.path, "--json"]);
    expect(JSON.parse(list.stdout).kind).toBe("projects");
    expect(JSON.parse(list.stdout).meta.resolvedCommand).toBeUndefined();
  });
});

describe("error ergonomics", () => {
  it("excess arguments name the command and its usage line", () => {
    const { stderr, exitCode } = runCli(["tags", "X", "Y"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("things tags");
    expect(stderr).toContain("usage: things tags");
    expect(stderr).toContain('"X"');
  });

  it("unknown subcommand of a group suggests a similar command", () => {
    // `config` is not an implied-show namespace, so a bad subcommand reaches
    // commander's unknown-command path with suggestions enabled.
    const { stderr, exitCode } = runCli(["config", "sett", "actor", "mike"]);
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("unknown command");
    expect(stderr).toContain("set");
  });
});

describe("write-command help states the contract", () => {
  it("todo add: loud unknown-reference behavior + reopen ack flag", () => {
    const help = helpFor("todo", "add");
    expect(help).toContain("unknown or ambiguous references are rejected");
    expect(help).toContain("reopens that project");
    expect(help).toContain("--acknowledge-project-reopen");
    expect(help).toContain("--dry-run");
  });

  it("todo update: repeating restriction is documented", () => {
    const help = helpFor("todo", "update");
    expect(help).toContain("not available for repeating to-dos");
  });

  it("todo checklist: destructive semantics + exact ack flag", () => {
    const help = helpFor("todo", "checklist");
    expect(help).toContain("--acknowledge-checklist-reset");
    expect(help).toContain("discarding the existing items");
    expect(help).toContain("PRESERVED");
  });

  it("project complete: mandatory children policy + cascade behavior", () => {
    const help = helpFor("project", "complete");
    expect(help).toContain("--children <policy>");
    expect(help).toContain("also completes its open to-dos");
  });

  it("project cancel: mandatory children policy + completed-children exemption", () => {
    const help = helpFor("project", "cancel");
    expect(help).toContain("--children <policy>");
    expect(help).toContain("also cancels its open to-dos");
    expect(help).toContain("never altered");
  });

  it("permanent deletes require --dangerously-permanent", () => {
    for (const path of [
      ["area", "delete"],
      ["tag", "delete"],
      ["trash", "empty"],
    ]) {
      const help = helpFor(...(path as [string, string]));
      expect(help).toContain("PERMANENTLY");
      expect(help).toContain("--dangerously-permanent");
    }
  });

  it("tag delete: subtree cascade + ack flag", () => {
    const help = helpFor("tag", "delete");
    expect(help).toContain("nested child tags are deleted with it");
    expect(help).toContain("--acknowledge-subtree");
  });

  it("area delete: to-dos trashed, projects orphaned", () => {
    const help = helpFor("area", "delete");
    expect(help).toContain("to-dos move to the Trash");
    expect(help).toContain("projects remain");
  });

  it("doctor: exit-code contract + setup guidance", () => {
    const help = helpFor("doctor");
    expect(help).toContain("Exit 0 healthy; 5 schema drift");
    expect(help).toContain("Enable Things URLs");
  });

  it("capabilities: discovery command exists", () => {
    const help = helpFor("capabilities");
    expect(help).toContain("operation kind");
    expect(help).toContain("--op");
  });

  it("todo update: reminder contract (scope, auto-preserve, clear)", () => {
    const help = helpFor("todo", "update");
    expect(help).toContain("--reminder <HH:mm>");
    expect(help).toContain("--clear-reminder");
    expect(help).toContain("auto-preserved");
    expect(help).toContain("can only be changed, not cleared");
    expect(help).toContain("--append-notes");
    expect(help).toContain("--prepend-notes");
  });

  it("todo duplicate: exact copy + repeating restriction", () => {
    const help = helpFor("todo", "duplicate");
    expect(help).toContain("exact copy");
    expect(help).toContain("repeating");
  });

  it("area/tag update: setters exist with behavior-scoped caveats", () => {
    const areaHelp = helpFor("area", "update");
    expect(areaHelp).toContain("--title");
    expect(areaHelp).toContain("must exist unless --create-tags");
    expect(areaHelp).toContain("--create-tags");
    const tagHelp = helpFor("tag", "update");
    expect(tagHelp).toContain("--parent");
    expect(tagHelp).toContain("--unnest");
    expect(tagHelp).toContain("--shortcut");
    expect(tagHelp).toContain("--clear-shortcut");
  });

  it("batch: no transactions, confirmation options, exit codes", () => {
    const help = helpFor("batch");
    expect(help).toContain("NO transactions");
    expect(help).toContain("acknowledgeTagSubtree");
    expect(help).toContain("--fail-fast");
    expect(help).toContain("--dry-run");
    expect(help).toContain("0 all ok");
  });

  it("changes: sync semantics and caveats", () => {
    const help = helpFor("changes");
    expect(help).toContain("--since <when>");
    expect(help).toContain("trashed");
    expect(help).toContain("invisible");
  });

  it("show router: shorthand + keyword routing documented; area sections expose caps", () => {
    const show = helpFor("show");
    expect(show).toContain("The word `show` may be omitted");
    expect(show).toContain("command names always win");
    expect(show).toContain("inbox|today|anytime|upcoming|someday|logbook|trash");
    for (const path of [["show"], ["area", "show"]]) {
      const help = helpFor(...(path as [string]));
      expect(help, path.join(" ")).toContain("--project-limit <n>");
      expect(help, path.join(" ")).toContain("--area-limit <n>");
      expect(help, path.join(" ")).toContain("--all");
      // No strict total cap on detail views — --limit is not offered.
      expect(help, path.join(" ")).not.toContain("--limit <n>");
    }
    // project show is UNCAPPED: headings are true containers.
    const project = helpFor("project", "show");
    expect(project).not.toContain("--limit <n>");
    expect(project).not.toContain("--area-limit");
  });

  it("flat list views expose --limit/--all; grouped views expose per-block caps", () => {
    for (const name of ["today", "inbox", "upcoming", "logbook", "trash", "changes"]) {
      const help = helpFor(name);
      expect(help, name).toContain("--limit <n>");
      expect(help, name).toContain("--all");
    }
    const anytime = helpFor("anytime");
    expect(anytime).toContain("--area-limit <n>");
    expect(anytime).toContain("--project-limit <n>");
    expect(anytime).toContain("--all");
    const someday = helpFor("someday");
    expect(someday).toContain("--area-limit <n>");
    expect(someday).not.toContain("--project-limit");
    expect(someday).toContain("--show-active-project-items [n]");
    // --limit exists on the grouped views only as a hidden usage-error trap.
    expect(anytime).not.toContain("--limit <n>");
    expect(someday).not.toContain("--limit <n>");
  });

  it("universal-flags charter: every list/detail view accepts --json/--db/--all", () => {
    // docs/design/cli-grammar.md — the three flags are universal across every
    // list and detail view (--all is a documented no-op where no default
    // restriction exists). A new view added without them fails here.
    const VIEWS: string[][] = [
      ["today"],
      ["inbox"],
      ["anytime"],
      ["someday"],
      ["upcoming"],
      ["logbook"],
      ["trash"],
      ["changes"],
      ["search"],
      ["projects"],
      ["areas"],
      ["tags"],
      ["show"],
      ["area", "show"],
      ["project", "show"],
      ["todo", "show"],
    ];
    for (const path of VIEWS) {
      const help = helpFor(...path);
      const name = path.join(" ");
      expect(help, name).toContain("--json");
      expect(help, name).toContain("--db <path>");
      expect(help, name).toContain("--all");
    }
  });

  it("current-work views + search expose --overdue with a behavioral one-liner", () => {
    // --overdue is a content scope on the current-work views and search; the
    // one-liner states behavior and the due-today carve-out.
    for (const name of ["today", "inbox", "anytime", "someday", "search"]) {
      const help = helpFor(name);
      expect(help, name).toContain("--overdue");
      expect(help, name).toContain("past their deadline");
      expect(help, name).toContain("due today is not overdue");
    }
    // Excluded views (forward-looking / closed-item) do NOT offer it.
    for (const name of ["upcoming", "logbook", "trash"]) {
      expect(helpFor(name), name).not.toContain("--overdue");
    }
  });

  it("list views + search expose --exact-tag alongside --tag", () => {
    for (const name of ["today", "inbox", "search", "logbook"]) {
      const help = helpFor(name);
      expect(help).toContain("--exact-tag");
      expect(help).toContain("exclude hierarchy descendants");
    }
  });

  it("search: open-by-default scope, widening flags, scoping flags", () => {
    const help = helpFor("search");
    expect(help).toContain("OPEN + untrashed");
    expect(help).toContain("--logged");
    expect(help).toContain("--trashed");
    expect(help).toContain("--all");
    expect(help).toContain("--project <ref>");
    expect(help).toContain("--area <ref>");
    expect(help).toContain("--tag <ref>");
    expect(help).toContain("descendant");
    expect(help).toContain("--limit <n>");
  });

  it("reorder: experimental gate, bounce cap, scope restrictions", () => {
    const help = helpFor("reorder");
    expect(help).toContain("EXPERIMENTAL");
    expect(help).toContain("allow-experimental");
    expect(help).toContain("bounce");
    expect(help).toContain("Evening and projects");
    expect(help).toContain("bounce-only");
    expect(help).toContain("carries its children");
    expect(help).toContain("--scope <scope>");
    expect(help).toContain("--strategy <name>");
    expect(help).toContain("--dry-run");
    expect(help).toContain("never mixed");
  });

  it("todo restore: trashed-only precondition + de-schedule caveat", () => {
    const help = helpFor("todo", "restore");
    expect(help).toContain("TRASHED");
    expect(help).toContain("DE-SCHEDULED");
  });

  it("todo move: exclusive destinations incl. inbox de-schedule + detach", () => {
    const help = helpFor("todo", "move");
    expect(help).toContain("--inbox");
    expect(help).toContain("removes any schedule");
    expect(help).toContain("--detach");
    expect(help).toContain("keeping the schedule");
  });

  it("project move: area destination or detach", () => {
    const help = helpFor("project", "move");
    expect(help).toContain("--area <ref>");
    expect(help).toContain("--detach");
    expect(help).toContain("Unknown areas are rejected");
  });

  it("project reopen: children stay resolved unless restored", () => {
    const help = helpFor("project", "reopen");
    expect(help).toContain("--restore-children");
    expect(help).toContain("resolved together with the project");
  });

  it("project duplicate: children included + repeating restriction", () => {
    const help = helpFor("project", "duplicate");
    expect(help).toContain("INCLUDING its children");
    expect(help).toContain("repeating");
  });

  it("upcoming: horizon projections documented as unmaterialized host math", () => {
    const help = helpFor("upcoming");
    expect(help).toContain("--horizon <n>");
    expect(help).toContain("PROJECTS");
    expect(help).toContain("fixed rules only");
    expect(help).toContain("--tag <ref>");
  });

  it("undo: own-changes-only scope, irreversibles, permanent gate", () => {
    const help = helpFor("undo");
    expect(help).toContain("INVERSE");
    expect(help).toContain("IRREVERSIBLE");
    expect(help).toContain("cannot be undone here");
    expect(help).toContain("--last <n>");
    expect(help).toContain("--dry-run");
    expect(help).toContain("--dangerously-permanent");
    expect(help).toContain("undo:<actor>");
  });

  it("mcp: stdio server + client-config recipe documented", () => {
    const help = helpFor("mcp");
    expect(help).toContain("stdio");
    expect(help).toContain("Model Context Protocol");
    expect(help).toContain('args ["mcp"]');
    expect(help).toContain("live area/tag/project inventory");
  });

  it("heading add: existing-project requirement + setup pointer", () => {
    const help = helpFor("heading", "add");
    expect(help).toContain("existing project");
    expect(help).toContain("things setup shortcuts");
  });

  it("todo clear-reminder: date-scheduled reminder + setup pointer", () => {
    const help = helpFor("todo", "clear-reminder");
    expect(help).toContain("date-scheduled");
    expect(help).toContain("things setup shortcuts");
  });

  it("legend: exists as a read command with --json", () => {
    const help = helpFor("legend");
    expect(help).toContain("symbols and colors");
    expect(help).toContain("--json");
  });

  it("list views point at `things legend` for the glyph language", () => {
    for (const name of ["today", "inbox", "anytime", "someday", "upcoming", "logbook", "trash"]) {
      expect(renderedHelp(name), name).toContain("run `things legend`");
    }
  });

  it("setup shortcuts: names the unlocked operations, the click, and --check", () => {
    const help = helpFor("setup", "shortcuts");
    expect(help).toContain("creating a heading in an existing project");
    expect(help).toContain("Add Shortcut");
    expect(help).toContain("Always Allow");
    expect(help).toContain("--check");
  });
});

describe("surface copy contract (docs/design/surface-copy.md)", () => {
  // Rule 2: help text states behavior, never mechanism. Internals live in
  // docs/ and in the capabilities OUTPUT — not in any --help string.
  const BANNED = [
    /\bH-[A-Z][A-Z-]+\b/, // hazard ids
    /\b[A-Z]\d{2}[A-Z]?\b/, // probe-evidence ids (P16, E06, A24B, ...)
    /vector:/, // "(vector: url-scheme, ...)" framing
    /\btier \d\b/i,
    /\bhazard/i,
    /read-after-write/,
    /\baudit\b/i,
    /\b(?:unprobed|probed|unvalidated|validated)\b/i,
    /\bsdef\b/,
  ];

  it("no --help string leaks internals", () => {
    const program = buildProgram();
    for (const [name, text] of allHelp(program as unknown as Command, [])) {
      for (const pattern of BANNED) {
        const match = text.match(pattern);
        expect(match, `"${name}" leaks "${match?.[0] ?? ""}" (${pattern})`).toBeNull();
      }
    }
  });

  it("no help TOPIC or the top-level index leaks internals", () => {
    const program = buildProgram();
    const surfaces: [string, string][] = [
      ["index", renderTopLevelHelp(program, 100)],
      ...TOPIC_NAMES.map((t): [string, string] => [`topic:${t}`, renderTopic(t, 100) ?? ""]),
    ];
    for (const [name, text] of surfaces) {
      for (const pattern of BANNED) {
        const match = text.match(pattern);
        expect(match, `"${name}" leaks "${match?.[0] ?? ""}" (${pattern})`).toBeNull();
      }
    }
  });
});
