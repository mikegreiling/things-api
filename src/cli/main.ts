#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * `things` — CLI over the things-api library. A thin surface: every command
 * routes through ThingsClient (or core functions like diagnose/capabilities);
 * contracts that bind are the exit codes and --json envelope (../contracts.ts).
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

import { registerDoctor } from "./commands/doctor.ts";
import { registerMcp } from "./commands/mcp.ts";
import { registerAreaCommands } from "./commands/area.ts";
import { registerProjectCommands } from "./commands/project.ts";
import { registerReadCommands } from "./commands/reads.ts";
import { registerSetup } from "./commands/setup.ts";
import { registerShowCommands } from "./commands/show.ts";
import { registerSnapshot } from "./commands/snapshot.ts";
import { registerTodoCommands } from "./commands/todo.ts";
import { registerWriteCommands } from "./commands/writes.ts";
import { resolveInvocation } from "./resolve-invocation.ts";
import { resolveWidth, setFitWidth } from "./width.ts";
import { ExitCode, PKG_VERSION } from "../contracts.ts";

// Authored UNWRAPPED; wrapped to the terminal at render time (agentNotesText)
// so the epilog reflows like commander's own sections instead of carrying
// hard breaks from some past terminal's width.
const AGENT_NOTE_BULLETS = [
  "Every command supports --json: versioned envelope on stdout, logs on stderr.",
  "Uuid parameters accept unique PREFIXES (>= 6 chars); list output shows 8+-char prefixes, --json always carries full uuids. Ambiguous prefixes fail with the candidates listed.",
  'A Things share link (Share > Copy Link, "things:///show?id=<uuid>") is accepted anywhere a uuid or name is expected — it is stripped to the id.',
  "The word `show` may be omitted: `things <ref>` shows the referenced item whenever <ref> is not a command name (command names always win).",
  "Exit codes are stable: 0 ok, 2 usage, 3 verify-failed, 4 blocked, 5 drift-blocked, 6 unsupported, 7 environment.",
  "No command ever prompts interactively; operations with cascading or permanent effects require explicit flags documented in their --help.",
  "Discover the full operation catalog with: things capabilities --json",
  "Symbols & colors in list output: run `things legend` (add --json for the table).",
  "Every write supports --dry-run: preview the planned change and its expected effect without executing anything.",
  "Failures are loud: a change that does not take effect exits 3; refused changes exit 4 with machine-readable remediation.",
];

/** Wrap one bullet to `width` with a hanging indent (`  - ` then 4 spaces). */
export function wrapBullet(text: string, width: number): string[] {
  const INDENT = 4;
  const room = Math.max(20, width) - INDENT;
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(" ")) {
    const candidate = cur === "" ? word : `${cur} ${word}`;
    if (candidate.length <= room || cur === "") cur = candidate;
    else {
      lines.push((lines.length === 0 ? "  - " : "    ") + cur);
      cur = word;
    }
  }
  if (cur !== "") lines.push((lines.length === 0 ? "  - " : "    ") + cur);
  return lines;
}

/** The AGENT NOTES epilog, reflowed to the current terminal (80 when piped, like commander). */
export function agentNotesText(): string {
  const width = process.stdout.columns ?? 80;
  return `\nAGENT NOTES:\n${AGENT_NOTE_BULLETS.flatMap((b) => wrapBullet(b, width)).join("\n")}\n`;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("things")
    .description("Programmatic interface to Things 3 (Cultured Code)")
    .version(PKG_VERSION)
    .addHelpText("after", () => agentNotesText());
  registerDoctor(program);
  registerReadCommands(program);
  registerShowCommands(program);
  registerProjectCommands(program);
  registerAreaCommands(program);
  registerTodoCommands(program);
  registerWriteCommands(program);
  registerSetup(program);
  registerSnapshot(program);
  registerMcp(program);
  return program;
}

export function runCli(): void {
  // Resolve the width-aware row fit ONCE at startup (docs/design/width-aware-
  // tty.md): THINGS_WIDTH override, else stdout.columns on a TTY, else null (no
  // fitting — pipes/grep/--json byte-stable). Threaded to the renderers via the
  // module-level fit width in ./width.ts, so every human list path inherits it
  // and MCP/--json never touch it.
  setFitWidth(
    resolveWidth({
      env: process.env,
      columns: process.stdout.columns,
      isTTY: process.stdout.isTTY === true,
    }),
  );
  const program = buildProgram();
  program.exitOverride((err) => {
    process.exit(err.exitCode === 0 ? ExitCode.Ok : ExitCode.Usage);
  });
  // The single router (docs/design/cli-grammar.md): classify the invocation,
  // then dispatch its normalized argv. Sugar forms (bare noun, keyword-in-show)
  // normalize into the canonical grammar here.
  const { argv } = resolveInvocation(program, process.argv.slice(2));
  program.parse(argv, { from: "user" });
}

// Direct-run detection must survive the npm .bin symlink (argv[1] ends with
// "things", not "main.js") — resolve through realpath and compare to this
// module. Caught by scripts/pack-smoke.sh: a name-suffix check made the
// installed bin a silent no-op. The bin/things.js launcher bypasses this by
// calling runCli() explicitly.
const isDirectRun = ((): boolean => {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  runCli();
}
