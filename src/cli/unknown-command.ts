/**
 * The unknown-command handler (docs/design/cli-grammar.md). A top-level
 * `things <token> <more…>` whose first token is neither a registered command
 * nor a view keyword CANNOT be the bare-noun sugar: a reference occupies
 * exactly one positional (`things show <ref>` takes one argument), so a second
 * positional means the token was meant as a COMMAND. Rewriting it to
 * `show <token> <more…>` reported an arity error against `things show` — a
 * command the user never typed — which is what this replaces:
 *
 *   $ things to-do Hobbies
 *   error: invalid command or ref: 'to-do'
 *   did you mean: things todo Hobbies
 *
 * The suggestion is the nearest command name by edit distance (transpositions
 * counted as one edit), offered only within a small radius; beyond it the error
 * stands alone. Exit class is Usage (exit 2), consistent with the other
 * resolver errors; under `--json` the suggestions ride
 * `error.detail.suggestions`.
 */
import type { Command } from "commander";

import { errorEnvelope, ExitCode, type EnvelopeMeta } from "../index.ts";
import { indexPastLeadingFlags, SHOW_KEYWORDS } from "./resolve-invocation.ts";
import { shellQuote } from "./shell-quote.ts";

/** At most this many alternatives are offered (all tied at the best distance). */
const MAX_SUGGESTIONS = 3;

/**
 * How far a token may sit from a command name and still be called a typo. A
 * short token is held to a tighter radius — at three characters or fewer, two
 * edits is most of the word.
 */
function suggestionRadius(token: string): number {
  return token.length <= 3 ? 1 : 2;
}

/**
 * Optimal string alignment distance: insertions, deletions, substitutions, and
 * ADJACENT TRANSPOSITIONS each cost one, so `todya` sits one edit from `today`.
 */
function editDistance(a: string, b: string): number {
  const cols = b.length + 1;
  const grid = new Int32Array((a.length + 1) * cols);
  const at = (i: number, j: number): number => grid[i * cols + j] ?? 0;
  const put = (i: number, j: number, v: number): void => {
    grid[i * cols + j] = v;
  };
  for (let i = 0; i <= a.length; i++) put(i, 0, i);
  for (let j = 0; j <= b.length; j++) put(0, j, j);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      // Adjacent transposition (`todya` → `today`) is ONE edit, not two.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, at(i - 2, j - 2) + cost);
      }
      put(i, j, best);
    }
  }
  return at(a.length, b.length);
}

/**
 * The command vocabulary a typo is measured against: every registered top-level
 * command name and alias, plus the view keywords that route at the bare level
 * without being commands of their own (the section sugars, e.g. `evening`).
 */
function commandVocabulary(program: Command): string[] {
  const names = new Set<string>(SHOW_KEYWORDS);
  names.add("help");
  for (const c of program.commands) {
    names.add(c.name());
    for (const alias of c.aliases()) names.add(alias);
  }
  return [...names].toSorted();
}

/**
 * The command names nearest `token`, all tied at the best distance within the
 * radius (capped). Empty when nothing is close enough — a token that resembles
 * no command gets the bare error rather than a misleading guess.
 */
function nearestCommands(program: Command, token: string): string[] {
  const needle = token.toLowerCase();
  const radius = suggestionRadius(needle);
  let best = Infinity;
  let winners: string[] = [];
  for (const name of commandVocabulary(program)) {
    const distance = editDistance(needle, name.toLowerCase());
    if (distance > radius || distance > best) continue;
    if (distance < best) {
      best = distance;
      winners = [];
    }
    winners.push(name);
  }
  return winners.slice(0, MAX_SUGGESTIONS);
}

/**
 * The corrected invocation for one candidate command: the user's own argv with
 * the offending token replaced. Every other token — trailing positionals and
 * flags alike — is echoed verbatim, so the suggestion is the command the caller
 * meant to type.
 */
function correctedCommand(args: string[], at: number, name: string): string {
  const parts = args.map((tok, i) => (i === at ? name : shellQuote(tok)));
  return `things ${parts.join(" ")}`;
}

/** The error line naming the token that matched neither a command nor a ref. */
function leadLine(token: string): string {
  return `invalid command or ref: '${token}'`;
}

/** Human render: the error, the corrected command(s), and the grammar reminder. */
function renderHuman(token: string, suggestions: string[]): string {
  const lines = [`error: ${leadLine(token)}`];
  if (suggestions.length === 1) {
    lines.push(`did you mean: ${suggestions[0]}`);
  } else if (suggestions.length > 1) {
    lines.push("did you mean:");
    for (const s of suggestions) lines.push(`  ${s}`);
  }
  lines.push(
    "",
    "A reference takes no further arguments — `things <ref>` shows one item. " +
      "See `things help` for the command list.",
  );
  return lines.join("\n");
}

/** The one-line message the `--json` envelope carries (suggestions folded in). */
function jsonMessage(token: string, suggestions: string[]): string {
  if (suggestions.length === 0) return leadLine(token);
  const forms = suggestions.map((s) => `\`${s}\``).join(", ");
  return suggestions.length === 1
    ? `${leadLine(token)} — did you mean ${forms}`
    : `${leadLine(token)} — did you mean one of: ${forms}`;
}

/**
 * Emit the unknown-command error and set the Usage exit code. Pure argv work —
 * it never opens the database, so an unreadable or absent database still gets
 * the routing error it deserves.
 */
export function runUnknownCommand(program: Command, args: string[]): void {
  const at = indexPastLeadingFlags(args) ?? 0;
  const token = args[at] ?? "";
  const suggestions = nearestCommands(program, token).map((name) =>
    correctedCommand(args, at, name),
  );
  if (args.includes("--json")) {
    const meta: EnvelopeMeta = { dbVersion: null, fingerprint: "unknown", elapsedMs: 0 };
    process.stdout.write(
      `${JSON.stringify(
        errorEnvelope(
          { code: "usage", message: jsonMessage(token, suggestions), detail: { suggestions } },
          meta,
        ),
      )}\n`,
    );
  } else {
    process.stderr.write(`${renderHuman(token, suggestions)}\n`);
  }
  process.exitCode = ExitCode.Usage;
}
