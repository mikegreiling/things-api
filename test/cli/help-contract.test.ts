/**
 * Help text is the agent API contract (design §3): agents discover the tool
 * through --help, so its load-bearing statements — behavior, side effects,
 * confirmation flag names, exit codes — are regression-tested here. These
 * assert the CONTRACT lines, not the full rendering, so cosmetic rewording
 * stays cheap while contract drift fails loudly. A companion suite enforces
 * the consumer-voice rules of docs/design/surface-copy.md.
 */
import { describe, expect, it } from "vitest";

import type { Command } from "commander";

import { buildProgram } from "../../src/cli/main.ts";

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

describe("root help", () => {
  it("carries the agent notes: --json, stable exit codes, no prompts", () => {
    const program = buildProgram();
    // AGENT NOTES lives in addHelpText(after); commander exposes it on render.
    let rendered = "";
    program.configureOutput({ writeOut: (s) => void (rendered += s) });
    program.exitOverride();
    try {
      program.parse(["node", "things", "--help"]);
    } catch {
      // exitOverride throws after help renders — expected
    }
    expect(rendered).toContain("AGENT NOTES");
    expect(rendered).toContain("0 ok, 2 usage, 3 verify-failed, 4 blocked");
    expect(rendered).toContain("5 drift-blocked, 6 unsupported, 7 environment");
    expect(rendered).toContain("No command ever prompts interactively");
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
    expect(areaHelp).toContain("must name existing");
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

  function allHelp(cmd: Command, path: string[]): [string, string][] {
    const own: [string, string][] = [
      [path.join(" ") || "(root)", cmd.helpInformation().replace(/\s+/g, " ")],
    ];
    return [...own, ...cmd.commands.flatMap((c) => allHelp(c, [...path, c.name()]))];
  }

  it("no --help string leaks internals", () => {
    const program = buildProgram();
    for (const [name, text] of allHelp(program as unknown as Command, [])) {
      for (const pattern of BANNED) {
        const match = text.match(pattern);
        expect(match, `"${name}" leaks "${match?.[0] ?? ""}" (${pattern})`).toBeNull();
      }
    }
  });
});
