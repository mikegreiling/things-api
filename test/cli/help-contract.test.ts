/**
 * Help text is the agent API contract (design §3): agents discover the tool
 * through --help, so its load-bearing statements — hazards, ack flag names,
 * vectors, tiers, exit codes — are regression-tested here. These assert the
 * CONTRACT lines, not the full rendering, so cosmetic rewording stays cheap
 * while contract drift fails loudly.
 */
import { describe, expect, it } from "vitest";

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
  it("todo add: vector, tier, hazards, ack flag", () => {
    const help = helpFor("todo", "add");
    expect(help).toContain("vector: url-scheme");
    expect(help).toContain("tier 0");
    expect(help).toContain("H-UNKNOWN-TAG");
    expect(help).toContain("H-REOPEN-RESOLVED-PROJECT");
    expect(help).toContain("--acknowledge-project-reopen");
    expect(help).toContain("--dry-run");
  });

  it("todo update: repeating-template hard-block is documented", () => {
    const help = helpFor("todo", "update");
    expect(help).toContain("H-REPEAT-SCHEDULE");
    expect(help).toContain("crashes Things");
  });

  it("todo checklist: destructive semantics + exact ack flag", () => {
    const help = helpFor("todo", "checklist");
    expect(help).toContain("H-CHECKLIST-REPLACE");
    expect(help).toContain("--acknowledge-checklist-reset");
    expect(help).toContain("destroys per-item state");
    expect(help).toContain("states PRESERVED");
  });

  it("project complete: mandatory children policy + verified cascade", () => {
    const help = helpFor("project", "complete");
    expect(help).toContain("--children <policy>");
    expect(help).toContain("auto-completes open");
    expect(help).toContain("verified");
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

  it("doctor: exit-code contract", () => {
    const help = helpFor("doctor");
    expect(help).toContain("Exit 0 healthy; 5 schema drift");
  });

  it("capabilities: discovery command exists and mentions vectors", () => {
    const help = helpFor("capabilities");
    expect(help).toContain("vector");
    expect(help).toContain("--op");
  });

  it("todo update: reminder contract (scope, auto-preserve, clear)", () => {
    const help = helpFor("todo", "update");
    expect(help).toContain("--reminder <HH:mm>");
    expect(help).toContain("--clear-reminder");
    expect(help).toContain("H-REMINDER-SCOPE");
    expect(help).toContain("auto-preserved");
    expect(help).toContain("--append-notes");
    expect(help).toContain("--prepend-notes");
  });

  it("todo duplicate: url-only path + template block", () => {
    const help = helpFor("todo", "duplicate");
    expect(help).toContain("url-scheme");
    expect(help).toContain("H-REPEAT-SCHEDULE");
  });

  it("area/tag update: setters exist with evidence-scoped caveats", () => {
    const areaHelp = helpFor("area", "update");
    expect(areaHelp).toContain("--title");
    expect(areaHelp).toContain("H-UNKNOWN-TAG");
    const tagHelp = helpFor("tag", "update");
    expect(tagHelp).toContain("--parent");
    expect(tagHelp).toContain("--unnest");
    expect(tagHelp).toContain("--shortcut");
    expect(tagHelp).toContain("unprobed");
  });

  it("batch: pipeline guarantees, no transactions, exit codes", () => {
    const help = helpFor("batch");
    expect(help).toContain("FULL pipeline");
    expect(help).toContain("No transactions");
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

  it("reorder: experimental gate, bounce cap, scope hazards", () => {
    const help = helpFor("reorder");
    expect(help).toContain("EXPERIMENTAL");
    expect(help).toContain("allow-experimental");
    expect(help).toContain("bounce");
    expect(help).toContain("Evening is bounce-only");
    expect(help).toContain("H-REORDER-SCOPE");
    expect(help).toContain("--scope <scope>");
    expect(help).toContain("--strategy <name>");
    expect(help).toContain("--dry-run");
    expect(help).toContain("never mixed");
  });

  it("todo restore: trashed-only precondition + de-schedule caveat", () => {
    const help = helpFor("todo", "restore");
    expect(help).toContain("TRASHED");
    expect(help).toContain("DE-SCHEDULED");
    expect(help).toContain("applescript");
  });

  it("project move: area destination, evidence-scoped", () => {
    const help = helpFor("project", "move");
    expect(help).toContain("--area <ref>");
    expect(help).toContain("applescript");
    expect(help).toContain("H-UNKNOWN-DESTINATION");
  });

  it("project duplicate: children included + template block", () => {
    const help = helpFor("project", "duplicate");
    expect(help).toContain("INCLUDING its children");
    expect(help).toContain("url-scheme");
    expect(help).toContain("H-REPEAT-SCHEDULE");
  });

  it("upcoming: horizon projections documented as unmaterialized host math", () => {
    const help = helpFor("upcoming");
    expect(help).toContain("--horizon <n>");
    expect(help).toContain("PROJECTS");
    expect(help).toContain("fixed rules only");
    expect(help).toContain("--tag <ref>");
  });

  it("undo: audit-replay contract — inverse pipeline, irreversibles, permanent gate", () => {
    const help = helpFor("undo");
    expect(help).toContain("INVERSE");
    expect(help).toContain("IRREVERSIBLE");
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

  it("project cancel/reopen/restore: lifecycle contract from the P-suite", () => {
    const cancel = helpFor("project", "cancel");
    expect(cancel).toContain("--children <policy>");
    expect(cancel).toContain("auto-cancel");
    expect(cancel).toContain("H-PROJECT-COMPLETE-CHILDREN");
    const reopen = helpFor("project", "reopen");
    expect(reopen).toContain("--restore-children");
    expect(reopen).toContain("stopDate window");
    const restore = helpFor("project", "restore");
    expect(restore).toContain("IN PLACE");
    expect(restore).toContain("trashed project");
  });

  it("detach: one-step container removal documented on both move commands", () => {
    expect(helpFor("todo", "move")).toContain("--detach");
    expect(helpFor("project", "move")).toContain("--detach");
    expect(helpFor("project", "move")).toContain("the only surface");
  });

  it("tag delete: subtree cascade hazard + ack flag", () => {
    const help = helpFor("tag", "delete");
    expect(help).toContain("H-TAG-SUBTREE-DELETE");
    expect(help).toContain("--acknowledge-subtree");
    expect(help).toContain("CHILD TAGS");
  });

  it("checklist: granular actions with preserved states", () => {
    const help = helpFor("todo", "checklist");
    expect(help).toContain("--check <title>");
    expect(help).toContain("--uncheck <title>");
    expect(help).toContain("--add <title>");
    expect(help).toContain("--rename <title>");
    expect(help).toContain("not stable");
  });

  it("project update: notes modes documented", () => {
    const help = helpFor("project", "update");
    expect(help).toContain("--append-notes");
    expect(help).toContain("--prepend-notes");
    expect(help).toContain("exclusive with --notes");
  });
});
