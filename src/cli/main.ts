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
import { registerProjectCommands } from "./commands/project.ts";
import { registerReadCommands } from "./commands/reads.ts";
import { registerSnapshot } from "./commands/snapshot.ts";
import { registerTodoCommands } from "./commands/todo.ts";
import { registerWriteCommands } from "./commands/writes.ts";
import { ExitCode, PKG_VERSION } from "../contracts.ts";

const AGENT_NOTES = `
AGENT NOTES:
  - Every command supports --json: versioned envelope on stdout, logs on stderr.
  - Exit codes are stable: 0 ok, 2 usage, 3 verify-failed, 4 blocked,
    5 drift-blocked, 6 unsupported, 7 environment.
  - No command ever prompts interactively; risky operations require explicit
    acknowledgement flags documented in their --help.
  - Discover the operation x vector support matrix with: things capabilities --json
  - Every write supports --dry-run: inspect the compiled invocation, disruption
    tier, hazards, and expected delta without executing anything.
  - Every mutation is verified by read-after-write and recorded in the audit
    trail (~/.local/state/things-api/audit/); blocked errors carry remediation.
`;

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("things")
    .description("Programmatic interface to Things 3 (Cultured Code)")
    .version(PKG_VERSION)
    .addHelpText("after", AGENT_NOTES);
  registerDoctor(program);
  registerReadCommands(program);
  registerProjectCommands(program);
  registerTodoCommands(program);
  registerWriteCommands(program);
  registerSnapshot(program);
  registerMcp(program);
  return program;
}

// Direct-run detection must survive the npm .bin symlink (argv[1] ends with
// "things", not "main.js") — resolve through realpath and compare to this
// module. Caught by scripts/pack-smoke.sh: a name-suffix check made the
// installed bin a silent no-op.
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
  const program = buildProgram();
  program.exitOverride((err) => {
    process.exit(err.exitCode === 0 ? ExitCode.Ok : ExitCode.Usage);
  });
  program.parse();
}
