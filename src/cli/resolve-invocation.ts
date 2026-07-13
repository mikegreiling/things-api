/**
 * The single command router (docs/design/cli-grammar.md). Takes raw user argv
 * (already stripped of the node/script prefix) and applies the precedence
 * chain — registered command/alias → view keyword → reference — returning a
 * normalized dispatch that `main.ts` feeds to commander. This replaces the
 * former `expandShorthand` argv hack, the per-command keyword rewrites, and
 * the hidden `--via-shorthand` marker.
 *
 * The resolver is argv-level and NEVER touches the database: it decides the
 * command SHAPE. Reference resolution (uuid prefix → share link → tiered name
 * match) happens later in `classifyShowTarget`, which needs the db. When a
 * form's canonical command is only knowable after that resolution (bare noun,
 * uuid/share-link routing), the `show`/`open` action fills `canonical` in via
 * `setInvocationCanonical`; the view-keyword rewrite knows it immediately.
 */
import type { Command } from "commander";

/**
 * `show`'s keyword vocabulary: EVERY list-view command name. `things show <kw>`
 * dispatches to the identical `things <kw>` command. Wider than the app's URL
 * ids because `show` renders our own views — the plurals are real commands too.
 */
export const SHOW_KEYWORDS = new Set([
  "inbox",
  "today",
  "anytime",
  "upcoming",
  "someday",
  "logbook",
  "trash",
  "projects",
  "areas",
  "tags",
]);

/**
 * `open`'s keyword vocabulary: ONLY the app's verified URL-scheme show ids.
 * `open`'s vocabulary belongs to the app (it hands the id straight to
 * `things:///show?id=<kw>`), so the plurals — which have no app list screen —
 * are deliberately excluded and rejected with a tailored error.
 */
export const OPEN_KEYWORDS = new Set([
  "inbox",
  "today",
  "anytime",
  "upcoming",
  "someday",
  "logbook",
  "trash",
]);

export type InvocationForm =
  /** A registered command/alias, or a flag-led/empty argv — nothing normalized. */
  | "canonical"
  /** `things <subject>` — the verb `show` was omitted. */
  | "bare-noun"
  /** `things show <ref>` — explicit loose router by reference. */
  | "loose-show"
  /** `things open <ref>` — explicit loose router by reference. */
  | "loose-open"
  /** `things show <view-keyword>` — rewritten to the `<view-keyword>` command. */
  | "show-keyword";

export interface ResolvedInvocation {
  form: InvocationForm;
  /** Normalized argv handed to commander (`from: "user"`). */
  argv: string[];
  /**
   * The canonical runnable command string, once known. Set at resolve time for
   * `show-keyword`; filled in by the `show` action after reference resolution
   * for the ref-routing forms; stays null for canonical invocations (and for
   * loose forms whose result is not a routing sugar worth echoing).
   */
  canonical: string | null;
  /** The subject/reference token (for the action to build the typed canonical). */
  ref: string | null;
}

let current: ResolvedInvocation | null = null;

/** The invocation the current process is running (null before `resolveInvocation`). */
export function getInvocation(): ResolvedInvocation | null {
  return current;
}

/**
 * Record the canonical command a ref-routing form resolved to, so the renderer
 * can echo it and stamp `meta.resolvedCommand`. No-op when the form is not a
 * routing sugar (canonical invocations echo nothing).
 */
export function setInvocationCanonical(canonical: string): void {
  if (current !== null) current.canonical = canonical;
}

/**
 * Classify raw user argv into a normalized dispatch and record it as the
 * current invocation. Idempotent per process; called once by `runCli` (and by
 * the in-process test harnesses) before commander parses.
 */
export function resolveInvocation(program: Command, args: string[]): ResolvedInvocation {
  current = classify(program, args);
  return current;
}

/**
 * Skip over LEADING GLOBAL-STYLE FLAGS to find the token being classified, so
 * `things --json Hobbies` routes exactly like `things Hobbies --json`. Only
 * the global read options are recognized here — `--json` (boolean) and `--db`
 * (value-taking: its value is skipped too, never misread as the subject).
 * Any other leading flag returns null — an unknown flag keeps the plain
 * fall-through to commander (which reports it), rather than guessing whether
 * the next token is that flag's value or the subject.
 */
function indexPastLeadingFlags(args: string[]): number | null {
  let i = 0;
  while (i < args.length) {
    const tok = args[i] ?? "";
    if (!tok.startsWith("-")) return i;
    if (tok === "--json") {
      i += 1;
    } else if (tok === "--db") {
      i += 2; // skip the flag AND its value
    } else if (tok.startsWith("--db=")) {
      i += 1;
    } else {
      return null; // unknown leading flag — commander's to handle
    }
  }
  return i; // flags only, no subject (e.g. bare `things --json`)
}

function classify(program: Command, args: string[]): ResolvedInvocation {
  const at = indexPastLeadingFlags(args);
  const first = at === null ? undefined : args[at];
  // An empty, flags-only, or unknown-flag-led argv is commander's to handle
  // (help, --version, error).
  if (first === undefined) {
    return { form: "canonical", argv: args, canonical: null, ref: null };
  }

  const known = new Set<string>(["help"]);
  for (const c of program.commands) {
    known.add(c.name());
    for (const alias of c.aliases()) known.add(alias);
  }

  if (at !== 0) {
    // A registered command reached THROUGH leading flags stays untouched:
    // program-level flags before a command were an error before and stay one.
    if (known.has(first)) {
      return { form: "canonical", argv: args, canonical: null, ref: null };
    }
    // Precedence 3 through leading global flags: a bare-noun subject routes
    // through `show` with the flags left in place — commander accepts options
    // before arguments on the subcommand.
    return { form: "bare-noun", argv: ["show", ...args], canonical: null, ref: first };
  }

  // Precedence 1: a registered command/alias always wins (names are reserved).
  if (known.has(first)) {
    if (first === "show") {
      const second = args[1];
      // Precedence 2 (show): a view keyword routes to that view command.
      if (second !== undefined && SHOW_KEYWORDS.has(second.toLowerCase())) {
        const kw = second.toLowerCase();
        return {
          form: "show-keyword",
          argv: [kw, ...args.slice(2)],
          canonical: `things ${kw}`,
          ref: kw,
        };
      }
      return { form: "loose-show", argv: args, canonical: null, ref: second ?? null };
    }
    if (first === "open") {
      // Precedence 2 (open) is handled in the action: keyword launching and the
      // plural-not-openable error both need the keyword sets, and open renders
      // no card to anchor an echo to.
      return { form: "loose-open", argv: args, canonical: null, ref: args[1] ?? null };
    }
    return { form: "canonical", argv: args, canonical: null, ref: null };
  }

  // Precedence 3: not a command — a bare-noun reference, routed through `show`.
  return { form: "bare-noun", argv: ["show", ...args], canonical: null, ref: first };
}
