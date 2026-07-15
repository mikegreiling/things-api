/**
 * Better excess-argument errors (design §5). Commander's default is a bare
 * "error: too many arguments for 'X'. Expected 0 arguments but got 1." — it
 * names neither the full command path nor its usage, and offers no next step.
 *
 * This walks the command tree once and replaces each command's private
 * `_excessArguments` with a message that: names the command (full path), shows
 * its usage line, echoes the unexpected tokens, and — when a single stray token
 * looks like a reference — suggests `things show <ref>` as the likely intent.
 * The pluralized list views (`areas`/`projects`) accept an optional id after
 * design §4, so their own stray-id case is handled there; this covers the rest.
 */
import type { Command } from "commander";

/** Commander internals this module reaches into (version-pinned in package.json). */
interface CommanderInternals {
  _allowExcessArguments: boolean;
  registeredArguments: readonly unknown[];
  _excessArguments?: (receivedArgs: string[]) => void;
  error: (message: string, opts?: { code?: string }) => never;
}

/** Full invocation path for a command: `things area show` (root name excluded). */
function commandPath(cmd: Command): string {
  const parts: string[] = [];
  // Walk up to — but not including — the root program (the node whose parent
  // is null); the root contributes the leading `things` exactly once.
  let cur: Command | null = cmd;
  while (cur !== null && cur.parent !== null) {
    parts.unshift(cur.name());
    cur = cur.parent;
  }
  return ["things", ...parts].join(" ");
}

/** Shell-safe echo of an unexpected token for the error line. */
function quote(token: string): string {
  return /[^\w./@:-]/.test(token) ? JSON.stringify(token) : `"${token}"`;
}

/** True when a stray token plausibly names an item (uuid, prefix, or a name). */
function looksLikeRef(token: string): boolean {
  return token !== "" && !token.startsWith("-");
}

function improve(cmd: Command): void {
  const internals = cmd as unknown as CommanderInternals;
  internals._excessArguments = function (receivedArgs: string[]): void {
    if (internals._allowExcessArguments) return;
    const expected = internals.registeredArguments.length;
    const extra = receivedArgs.slice(expected);
    const path = commandPath(cmd);
    const got = extra.map(quote).join(", ");
    const head =
      expected === 0
        ? `\`${path}\` takes no positional arguments`
        : `\`${path}\` accepts ${expected} argument${expected === 1 ? "" : "s"}`;
    const usage = `usage: ${path} ${cmd.usage()}`;
    const lines = [`error: ${head}, but got: ${got}`, usage];
    // A single stray ref most often means the caller meant to view that item.
    if (extra.length === 1 && looksLikeRef(extra[0] ?? "")) {
      lines.push(`to view one item: \`things show ${extra[0]}\``);
    }
    internals.error(lines.join("\n"), { code: "commander.excessArguments" });
  };
}

/** Apply the improved excess-argument message to a command and all descendants. */
export function installExcessArgsHelp(program: Command): void {
  const walk = (cmd: Command): void => {
    improve(cmd);
    for (const sub of cmd.commands) walk(sub);
  };
  walk(program);
}
