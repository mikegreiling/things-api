/**
 * The scheduling-intent hint for a namespaced `move` (docs/design/cli-grammar.md).
 * `things todo move <ref>` and `things project move <ref>` take CONTAINER
 * destinations only (--area/--project/--heading; todo also --inbox/--detach).
 * An agent carrying scheduling intent ("move X to Someday") reaches for
 * spellings `move` does not accept — `--to someday`, `--when today`,
 * `--someday`, or a bare `someday` positional — and would otherwise land on a
 * bare unknown-option / excess-argument usage error that never names the
 * command which actually schedules an item.
 *
 * This runs BEFORE commander parses (like the bare-verb hint) and, when it
 * recognizes scheduling vocabulary on a `move` invocation, answers with the
 * concrete command that works:
 *
 *   - a scheduling term (`someday`/`today`/`evening`/`anytime`/a date), as a
 *     flag value or a stray positional → `things <group> update <ref> --when <value>`.
 *   - a bare `inbox` positional on `todo move` → `things todo move <ref> --inbox`
 *     (the real Inbox-return; `--when inbox` is not a thing).
 *
 * It NEVER fires on a valid move: every trapped spelling is already a usage
 * error, so the accepted grammar is unchanged. Exit class stays Usage (2);
 * under `--json` the suggestion rides `error.details.suggestions`.
 */
import type { Command } from "commander";

import { errorEnvelope, ExitCode, type EnvelopeMeta } from "../index.ts";
import { indexPastLeadingFlags } from "./resolve-invocation.ts";
import { shellQuote } from "./shell-quote.ts";

/** The write groups whose `move` subcommand this hint guards. */
const MOVE_GROUPS = new Set(["todo", "project"]);

/**
 * Flag spellings that signal scheduling intent on a `move` — none is a real
 * `move` option, so their presence is always a usage error we can improve.
 * `--inbox` is deliberately absent: it is a genuine `todo move` destination.
 */
const SCHEDULING_FLAGS = new Set([
  "--to",
  "--when",
  "--someday",
  "--today",
  "--evening",
  "--anytime",
  "--date",
  "--schedule",
]);

/** Scheduling flags that carry their term as the NEXT token (or `--flag=term`). */
const VALUE_SCHEDULING_FLAGS = new Set(["--to", "--when", "--date", "--schedule"]);

/** Boolean-style scheduling flags whose name IS the `--when` term. */
const FLAG_TERM: Record<string, string> = {
  "--someday": "someday",
  "--today": "today",
  "--evening": "evening",
  "--anytime": "anytime",
};

/** Recognized `--when` terms (a date is matched separately). */
const WHEN_TERMS = new Set(["today", "evening", "anytime", "someday"]);

/** Positional destinations that read as scheduling intent, not a container. */
const SCHEDULING_POSITIONALS = new Set(["someday", "today", "evening", "anytime", "inbox"]);

/** A bare `YYYY-MM-DD` — a valid `--when` value, never a container name. */
function isDate(token: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(token);
}

/** The corrected command this hint points at. */
export interface MoveHint {
  group: "todo" | "project";
  /** Whether the caller asked for a --json envelope. */
  json: boolean;
  /** Inbox return vs. a schedule change — selects the wording. */
  intent: "schedule" | "inbox";
  /** The full, runnable suggestion (already shell-quoted). */
  suggestion: string;
}

/** Long/short flag names of `<group> move` that consume the following token. */
function valueFlagsFor(program: Command, group: string): Set<string> {
  const names = new Set<string>();
  const groupCmd = program.commands.find((c) => c.name() === group);
  const moveCmd = groupCmd?.commands.find((c) => c.name() === "move");
  if (moveCmd === undefined) return names;
  for (const opt of moveCmd.options) {
    // Commander marks value-taking options `<x>` (required) or `[x]` (optional).
    if (opt.required === true || opt.optional === true) {
      if (opt.long !== undefined) names.add(opt.long);
      if (opt.short !== undefined) names.add(opt.short);
    }
  }
  return names;
}

/** Map a raw scheduling term to a valid `--when` value (park by default). */
function whenValue(term: string | null): string {
  if (term !== null && (WHEN_TERMS.has(term.toLowerCase()) || isDate(term))) {
    return term.toLowerCase() === term ? term : term.toLowerCase();
  }
  return "someday";
}

interface Scan {
  ref: string | null;
  /** The stray second positional (a `move` destination is a flag, never this). */
  dest: string | null;
  /** The scheduling term carried by the first scheduling FLAG seen, if any. */
  flagTerm: string | null;
  /** True once any scheduling flag has been seen. */
  flagIntent: boolean;
}

/**
 * Walk the tokens after `<group> move`, skipping global/known value flags so
 * their values are never misread as a positional destination (`--heading
 * someday` moves under a heading literally named "someday" — not a trap).
 */
function scan(tokens: string[], valueFlags: Set<string>): Scan {
  const positionals: string[] = [];
  let flagTerm: string | null = null;
  let flagIntent = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    if (tok.startsWith("-")) {
      const eq = tok.indexOf("=");
      const name = eq >= 0 ? tok.slice(0, eq) : tok;
      const inline = eq >= 0 ? tok.slice(eq + 1) : undefined;
      if (SCHEDULING_FLAGS.has(name)) {
        if (!flagIntent) {
          if (VALUE_SCHEDULING_FLAGS.has(name)) {
            flagTerm = inline ?? tokens[i + 1] ?? null;
          } else {
            flagTerm = FLAG_TERM[name] ?? null;
          }
          flagIntent = true;
        }
        if (VALUE_SCHEDULING_FLAGS.has(name) && inline === undefined) i++; // consume its term
      } else if (valueFlags.has(name) && inline === undefined) {
        i++; // a known value flag — skip its value, it is not a positional
      }
      // boolean / unknown flags carry no positional to protect
    } else {
      positionals.push(tok);
    }
  }
  return {
    ref: positionals[0] ?? null,
    dest: positionals[1] ?? null,
    flagTerm,
    flagIntent,
  };
}

/**
 * Classify a `<group> move` invocation for scheduling intent. Returns the
 * corrected-command hint when a trapped spelling is present, else null (the
 * invocation falls through to commander unchanged).
 */
export function detectMoveHint(program: Command, argv: string[]): MoveHint | null {
  const at = indexPastLeadingFlags(argv);
  if (at === null) return null;
  const group = argv[at];
  if (group === undefined || !MOVE_GROUPS.has(group)) return null;
  if (argv[at + 1] !== "move") return null;
  const g = group as "todo" | "project";

  const s = scan(argv.slice(at + 2), valueFlagsFor(program, group));
  const json = argv.includes("--json");
  const refEcho = s.ref !== null ? shellQuote(s.ref) : "<ref>";

  // Precedence: an explicit scheduling FLAG wins over a positional read.
  if (s.flagIntent) {
    return {
      group: g,
      json,
      intent: "schedule",
      suggestion: `things ${g} update ${refEcho} --when ${whenValue(s.flagTerm)}`,
    };
  }

  // A stray positional destination that reads as scheduling vocabulary.
  const dest = s.dest;
  if (dest === null) return null;
  const lower = dest.toLowerCase();
  if (lower === "inbox") {
    // Only to-dos have an Inbox, and its return is a flag (`--when inbox` is not
    // a thing). A project has no Inbox — leave that to commander.
    if (g !== "todo") return null;
    return {
      group: g,
      json,
      intent: "inbox",
      suggestion: `things todo move ${refEcho} --inbox`,
    };
  }
  if (SCHEDULING_POSITIONALS.has(lower) || isDate(dest)) {
    return {
      group: g,
      json,
      intent: "schedule",
      suggestion: `things ${g} update ${refEcho} --when ${whenValue(dest)}`,
    };
  }
  return null;
}

/** The lead line naming what `move` does — scheduling vs. Inbox framing. */
function leadLine(hint: MoveHint): string {
  return hint.intent === "inbox"
    ? `error: \`things ${hint.group} move\` takes a container flag, not a positional destination.`
    : `error: \`things ${hint.group} move\` changes an item's container, not its schedule.`;
}

/** The action line inviting the corrected command. */
function actionLine(hint: MoveHint): string {
  return hint.intent === "inbox"
    ? `to send an item back to the Inbox use: ${hint.suggestion}`
    : `to schedule or park an item use: ${hint.suggestion}`;
}

/** Human render: the framing line, the corrected command, the container reminder. */
function renderHuman(hint: MoveHint): string {
  return [
    leadLine(hint),
    actionLine(hint),
    `move changes containers (--area/--project/--heading).`,
  ].join("\n");
}

/**
 * Emit the scheduling-intent hint and set the Usage exit code. Never opens the
 * write pipeline — it only rewrites the failing invocation into a working one.
 */
export function runMoveHint(hint: MoveHint): void {
  if (hint.json) {
    const meta: EnvelopeMeta = { dbVersion: null, fingerprint: "unknown", elapsedMs: 0 };
    const message = `${leadLine(hint).replace(/^error: /, "")} ${actionLine(hint)}`;
    process.stdout.write(
      `${JSON.stringify(
        errorEnvelope(
          { code: "usage", message, details: { suggestions: [hint.suggestion] } },
          meta,
        ),
      )}\n`,
    );
  } else {
    process.stderr.write(`${renderHuman(hint)}\n`);
  }
  process.exitCode = ExitCode.Usage;
}
