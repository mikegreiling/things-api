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
    expect(help).toContain("Destroys per-item completion state");
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
    expect(tagHelp).toContain("--shortcut");
    expect(tagHelp).toContain("unprobed");
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
  });
});
