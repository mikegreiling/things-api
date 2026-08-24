/**
 * Universal `--dry-run` (docs/design/cli-grammar.md). The flag is accepted by
 * EVERY `things` command, root included, with one contract: "guarantee nothing
 * changes". It reaches the CLI through two cooperating pieces —
 *
 *   1. {@link applyUniversalDryRun} declares the option. The DB-mutation write
 *      family already declares its OWN visible `--dry-run` (`addWriteFlags` in
 *      ./commands/writes.ts, plus `batch`/`undo`), where the flag previews the
 *      planned change; this decorator adds a HIDDEN `--dry-run` to every
 *      remaining LEAF command (a command with no subcommands) so a read accepts
 *      it (and returns byte-identical output — the normal view IS the correct
 *      dry-run of a read) and a future leaf inherits it automatically. Local-
 *      side-effect leaves (config set, install-skill, setup, the
 *      `open` reveals, mcp) get the hidden option too, and their actions read
 *      `opts.dryRun` and honor it (an honest preview, or a loud refusal).
 *
 *      The option is declared on LEAVES only — never on the root, a namespace
 *      group (`todo`/`project`/`area`/`config`/`setup`), or `trash` (a read view
 *      that also parents `trash empty`). Commander treats a parent's option as
 *      global and would swallow the flag before the child could parse it — which
 *      for a write child would silently turn a dry-run into a real change — so an
 *      ancestor must never declare it.
 *
 *   2. {@link stripInertDryRun} keeps the non-leaf forms from erroring on the
 *      now-undeclared flag. On a command that does NOT consume `--dry-run` (the
 *      root, a bare namespace group, or the `trash` view) the flag is a pure
 *      no-op, so it is dropped from the normalized argv before commander parses —
 *      `things --dry-run`, `things todo --dry-run`, and `things trash --dry-run`
 *      all behave exactly as the flag-less invocation. Consuming commands (every
 *      write verb and the decorated leaves) keep the flag untouched.
 *
 * The single root-help line (help.ts) states the universal contract; per-command
 * help stays quiet (the leaf option is hidden).
 */
import { Option, type Command } from "commander";

/** True when this command declares its own `--dry-run` option. */
export function declaresDryRun(cmd: Command): boolean {
  return cmd.options.some((o) => o.long === "--dry-run");
}

/**
 * Make `--dry-run` universal: walk the registered command tree and add a hidden
 * `--dry-run` to every LEAF command that does not already declare one. Leaves
 * only — an ancestor that declares the option would steal it from its
 * subcommands (see the module note). Idempotent per node. Call once, last, in
 * `buildProgram` so every leaf — present and future — inherits it.
 */
export function applyUniversalDryRun(program: Command): void {
  const walk = (cmd: Command): void => {
    const isLeaf = cmd.commands.length === 0;
    if (isLeaf && !declaresDryRun(cmd)) {
      cmd.addOption(
        new Option(
          "--dry-run",
          "guarantee nothing changes: reads return their normal output; writes preview the change",
        ).hideHelp(),
      );
    }
    for (const sub of cmd.commands) walk(sub);
  };
  walk(program);
}

/**
 * Resolve the command an argv will dispatch to by walking subcommand names in
 * order (skipping any option token). Stops at the first token that is not a
 * registered subcommand of the current node — so it lands on the executing leaf,
 * a namespace group, or the root itself.
 */
function targetCommand(program: Command, argv: readonly string[]): Command {
  let cmd = program;
  for (const tok of argv) {
    if (tok.startsWith("-")) continue;
    const next = cmd.commands.find((c) => c.name() === tok || c.aliases().includes(tok));
    if (next === undefined) break;
    cmd = next;
  }
  return cmd;
}

/**
 * Drop `--dry-run` from an argv whose target command does not consume it — the
 * root, a bare namespace group, or the `trash` view. On those, `--dry-run` is a
 * pure no-op (they only render help or a read), so removing it keeps the
 * universal "accepted everywhere" promise without commander erroring on an
 * undeclared option. A command that DOES declare `--dry-run` (every write verb
 * and the decorated leaves) keeps the flag untouched. Returns a new array only
 * when something was removed; otherwise the input is returned as-is.
 */
export function stripInertDryRun(program: Command, argv: string[]): string[] {
  if (!argv.includes("--dry-run")) return argv;
  if (declaresDryRun(targetCommand(program, argv))) return argv;
  return argv.filter((tok) => tok !== "--dry-run");
}
