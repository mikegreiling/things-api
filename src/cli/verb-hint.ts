/**
 * The bare-mutation-verb handler (docs/design/cli-grammar.md). A top-level
 * `things <verb> …` whose first token is a write verb (update, add, delete, …)
 * used to fall into the show-sugar and emit a confusing `things show` usage
 * error. Instead the resolver flags it `verb-hint` and this handler suggests
 * the namespaced write command:
 *
 *   - a following ref that uniquely resolves as an area/project/to-do → one
 *     CONCRETE suggestion echoing the remaining args
 *     (`did you mean: things area update health --tags test`). The mutation is
 *     NEVER auto-run — the suggestion is the deliberate keystroke.
 *   - `add`/`create` with a title-like arg → `things todo add "<arg>"` first
 *     (the common intent), then the other namespaces.
 *   - no ref, an unresolvable ref, or an ambiguous ref → a hint listing the
 *     namespaced forms and pointing at `things help writes`.
 *
 * Exit class is Usage (exit 2), consistent with the other resolver errors;
 * under `--json` the suggestions ride `error.details.suggestions`.
 */
import type { Command } from "commander";

import { openThings } from "../client.ts";
import { errorEnvelope, ExitCode, type EnvelopeMeta } from "../contracts.ts";
import { indexPastLeadingFlags, subcommandsOf, WRITE_GROUP_ORDER } from "./resolve-invocation.ts";
import { shellQuote } from "./shell-quote.ts";

/** The type-group a resolved reference maps to a write namespace by. */
const KIND_GROUP: Record<string, string> = { "to-do": "todo", project: "project", area: "area" };

interface ParsedVerbHint {
  verb: string;
  /** The first positional token after the verb, if any (the write target). */
  ref: string | null;
  /**
   * Everything after the verb EXCEPT the ref positional and the global read
   * flags (--json/--db) — the flags to echo back in the suggestion.
   */
  tail: string[];
  json: boolean;
  db: string | undefined;
}

/** Split the raw argv into verb, ref, echo-tail, and the global read opts. */
function parse(args: string[]): ParsedVerbHint {
  const at = indexPastLeadingFlags(args) ?? 0;
  const verb = args[at] ?? "";
  const after = args.slice(at + 1);
  let json = false;
  let db: string | undefined;
  let ref: string | null = null;
  const tail: string[] = [];
  for (let i = 0; i < after.length; i++) {
    const tok = after[i] ?? "";
    if (tok === "--json") {
      json = true;
    } else if (tok === "--db") {
      db = after[++i];
    } else if (tok.startsWith("--db=")) {
      db = tok.slice("--db=".length);
    } else if (!tok.startsWith("-") && ref === null) {
      ref = tok; // the first positional is the write target
    } else {
      tail.push(tok);
    }
  }
  // A leading --json/--db (before the verb) still governs output/target.
  for (let i = 0; i < at; i++) {
    const tok = args[i] ?? "";
    if (tok === "--json") json = true;
    else if (tok === "--db") db = args[++i];
    else if (tok.startsWith("--db=")) db = tok.slice("--db=".length);
  }
  return { verb, ref, tail, json, db };
}

/** Build `things <group> <verb> <ref?> <trailing flags…>` for the suggestion echo. */
function typedForm(group: string, verb: string, ref: string | null, tail: string[]): string {
  const parts = ["things", group, verb, ...(ref !== null ? [shellQuote(ref)] : []), ...tail];
  return parts.join(" ");
}

/** The write groups (in a stable order) whose registered verbs include `verb`. */
function groupsWithVerb(program: Command, verb: string): string[] {
  return WRITE_GROUP_ORDER.filter((g) => subcommandsOf(program, g).has(verb));
}

/** Classify the ref's type with the read client; null when it does not uniquely resolve. */
function resolvedGroup(db: string | undefined, ref: string): string | null {
  let client: ReturnType<typeof openThings> | null = null;
  try {
    client = openThings(db ? { dbPath: db } : {});
    const target = client.read.showTarget(ref);
    return KIND_GROUP[target.kind] ?? null;
  } catch {
    // Ambiguous, unresolvable, or an unreadable db all fall to the generic hint.
    return null;
  } finally {
    client?.close();
  }
}

/**
 * Compose the suggestion set for a bare verb. The first line is the best guess;
 * the rest are the other namespaced forms worth offering.
 */
function suggestionsFor(program: Command, p: ParsedVerbHint): string[] {
  const verbLower = p.verb.toLowerCase();

  // add/create: the target is a NEW title, so a name never "resolves" — offer
  // to-do first (the common intent), then the container namespaces.
  if (verbLower === "add" || verbLower === "create") {
    if (p.ref === null) return [];
    return [
      typedForm("todo", "add", p.ref, p.tail),
      typedForm("project", "add", p.ref, p.tail),
      typedForm("area", "add", p.ref, p.tail),
    ];
  }

  const applicable = groupsWithVerb(program, verbLower);
  // A ref that uniquely resolves to an area/project/to-do gets ONE concrete
  // suggestion — but only when that type actually offers the verb.
  if (p.ref !== null) {
    const group = resolvedGroup(p.db, p.ref);
    if (group !== null && applicable.includes(group)) {
      return [typedForm(group, p.verb, p.ref, p.tail)];
    }
  }
  // Generic: every namespace that offers the verb (fall back to all write
  // groups if the verb is a synonym none register directly).
  const groups = applicable.length > 0 ? applicable : WRITE_GROUP_ORDER;
  return groups.map((g) => typedForm(g, p.verb, p.ref, p.tail));
}

/** Human render: the error line, the suggestion(s), and the writes signpost. */
function renderHuman(verb: string, suggestions: string[]): string {
  const lines: string[] = [];
  if (suggestions.length === 0) {
    lines.push(
      `error: \`things ${verb}\` is a write verb but names no target — writes are namespaced.`,
    );
  } else if (suggestions.length === 1) {
    lines.push(`error: \`things ${verb} …\` is not a command — did you mean:`);
    lines.push(`  ${suggestions[0]}`);
  } else {
    lines.push(`error: \`things ${verb} …\` is not a command — writes are namespaced. Try:`);
    for (const s of suggestions) lines.push(`  ${s}`);
  }
  lines.push("", "See `things help writes` for the full write grammar.");
  return lines.join("\n");
}

/**
 * Run the bare-verb hint: emit the suggestion(s) and set the Usage exit code.
 * Never opens the write pipeline — this only reads to classify the ref.
 */
export function runVerbHint(program: Command, args: string[]): void {
  const p = parse(args);
  const suggestions = suggestionsFor(program, p);
  if (p.json) {
    const meta: EnvelopeMeta = { dbVersion: null, fingerprint: "unknown", elapsedMs: 0 };
    const message =
      suggestions.length === 1
        ? `\`things ${p.verb} …\` is not a command — did you mean \`${suggestions[0]}\``
        : `\`things ${p.verb} …\` is not a command — writes are namespaced (see \`things help writes\`)`;
    process.stdout.write(
      `${JSON.stringify(
        errorEnvelope({ code: "usage", message, details: { suggestions } }, meta),
      )}\n`,
    );
  } else {
    process.stderr.write(`${renderHuman(p.verb, suggestions)}\n`);
  }
  process.exitCode = ExitCode.Usage;
}
