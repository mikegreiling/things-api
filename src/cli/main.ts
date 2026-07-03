#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * `things` — CLI over the things-api library.
 *
 * Phase 0 scaffold: command surface lands in Phase 1 (reads) and Phase 5
 * (writes). Contracts that already bind: exit codes (./exit-codes.ts) and
 * the --json envelope (./output.ts).
 */
import { Command } from "commander";

import { registerDoctor } from "./commands/doctor.ts";
import { registerProjectCommands } from "./commands/project.ts";
import { registerReadCommands } from "./commands/reads.ts";
import { registerSnapshot } from "./commands/snapshot.ts";
import { registerTodoCommands } from "./commands/todo.ts";
import { registerWriteCommands } from "./commands/writes.ts";
import { ExitCode } from "./exit-codes.ts";

const AGENT_NOTES = `
AGENT NOTES:
  - Every command supports --json: versioned envelope on stdout, logs on stderr.
  - Exit codes are stable: 0 ok, 2 usage, 3 verify-failed, 4 blocked,
    5 drift-blocked, 6 unsupported, 7 environment.
  - No command ever prompts interactively; risky operations require explicit
    acknowledgement flags documented in their --help.
`;

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("things")
    .description("Programmatic interface to Things 3 (Cultured Code)")
    .version("0.0.1")
    .addHelpText("after", AGENT_NOTES);
  registerDoctor(program);
  registerReadCommands(program);
  registerProjectCommands(program);
  registerTodoCommands(program);
  registerWriteCommands(program);
  registerSnapshot(program);
  return program;
}

const isDirectRun = process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js");
if (isDirectRun) {
  const program = buildProgram();
  program.exitOverride((err) => {
    process.exit(err.exitCode === 0 ? ExitCode.Ok : ExitCode.Usage);
  });
  program.parse();
}
