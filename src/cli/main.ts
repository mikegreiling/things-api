#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * `things` — CLI over the things-api library. A thin surface: every command
 * routes through ThingsClient (or core functions like diagnose/capabilities);
 * contracts that bind are the exit codes and --json envelope (../contracts.ts).
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

import { registerHelp } from "./help.ts";
import { installExcessArgsHelp } from "./excess-args.ts";
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

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("things")
    .description("Programmatic interface to Things 3 (Cultured Code)")
    .version(PKG_VERSION)
    // Unknown-command typos are answered with "did you mean …" (default on;
    // stated for the record — most top-level typos route through the bare-noun
    // did-you-mean instead, this covers the subcommand groups).
    .showSuggestionAfterError(true);
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
  // The signpost index + `help [topic]` replace the multi-scroll epilog; the
  // improved excess-argument message names the command and its usage line.
  registerHelp(program);
  installExcessArgsHelp(program);
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
