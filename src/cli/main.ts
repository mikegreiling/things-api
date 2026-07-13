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
import { ExitCode, PKG_VERSION } from "../contracts.ts";

const AGENT_NOTES = `
AGENT NOTES:
  - Every command supports --json: versioned envelope on stdout, logs on stderr.
  - Uuid parameters accept unique PREFIXES (>= 6 chars); list output shows
    8+-char prefixes, --json always carries full uuids. Ambiguous prefixes
    fail with the candidates listed.
  - A Things share link (Share > Copy Link, "things:///show?id=<uuid>") is
    accepted anywhere a uuid or name is expected — it is stripped to the id.
  - The word \`show\` may be omitted: \`things <ref>\` shows the referenced
    item whenever <ref> is not a command name (command names always win).
  - Exit codes are stable: 0 ok, 2 usage, 3 verify-failed, 4 blocked,
    5 drift-blocked, 6 unsupported, 7 environment.
  - No command ever prompts interactively; operations with cascading or
    permanent effects require explicit flags documented in their --help.
  - Discover the full operation catalog with: things capabilities --json
  - Symbols & colors in list output: run \`things legend\` (add --json for the table).
  - Every write supports --dry-run: preview the planned change and its
    expected effect without executing anything.
  - Failures are loud: a change that does not take effect exits 3; refused
    changes exit 4 with machine-readable remediation.
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

/**
 * The view keywords of the app's show?id vocabulary: `things show <keyword>`
 * IS that view (dispatched to the view command so flags and output match
 * exactly), and the keyword beats a same-named project or area — the typed
 * forms (`things area show Anytime`) remain the escape hatch.
 */
const VIEW_KEYWORDS = new Set([
  "inbox",
  "today",
  "anytime",
  "upcoming",
  "someday",
  "logbook",
  "trash",
]);

/**
 * Bare-noun shorthand over user args (argv without the node/script prefix):
 * a first argument that is not a flag and not a registered command name (or
 * alias) becomes `show <ref>` — commands are RESERVED and always win. The
 * inserted hidden marker lets an unresolvable ref error as "no command or
 * item". `show <view keyword>` rewrites to the view command itself.
 */
export function expandShorthand(program: Command, args: string[]): string[] {
  const first = args[0];
  if (first === undefined || first.startsWith("-")) return args;
  const known = new Set<string>(["help"]);
  for (const c of program.commands) {
    known.add(c.name());
    for (const alias of c.aliases()) known.add(alias);
  }
  if (known.has(first)) {
    const second = args[1];
    if (first === "show" && second !== undefined && VIEW_KEYWORDS.has(second.toLowerCase())) {
      return [second.toLowerCase(), ...args.slice(2)];
    }
    return args;
  }
  return ["show", "--via-shorthand", ...args];
}

export function runCli(): void {
  const program = buildProgram();
  program.exitOverride((err) => {
    process.exit(err.exitCode === 0 ? ExitCode.Ok : ExitCode.Usage);
  });
  program.parse(expandShorthand(program, process.argv.slice(2)), { from: "user" });
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
